import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// LINUX BUG HUNT follow-up (2026-08-29, linux-bug-hunt-2026-08-29): the live
// Discord report (Stop/Force Stop/Restart stuck disabled while RCON works)
// had TWO separate real bugs. The first (a client-side "false ?? X" JS
// defect, fixed in ffd8aaf) explains why the UI ignored RCON evidence. This
// covers the second, deeper one god asked to be fixed directly: WHY the
// Linux process scan itself can confidently, wrongly, report a genuinely
// running server as not running in the first place.
//
// isLinuxDedicatedServerCommandLine() requires a specific launch shape
// (zombie.network.GameServer, or ProjectZomboid64/32 + a -server-ish flag).
// A real PZ server invoked a different way -- proven here with a -jar-style
// launcher, plausible for Build 42's shaded jar -- produces a command line
// that shape doesn't recognize, and the OLD code returned
// {running:false, scanFailed:false}: a CONFIDENT wrong answer.
//
// CI REGRESSION, SAME DAY (a5c5ce2 -> reverted -> this file): a first
// version of the fix treated ANY process merely mentioning "zomboid" in its
// command line (fails the narrow shape) as ambiguous evidence. On a GitHub
// Actions runner the repo checks out to a path containing the repo's own
// name (.../zomboid-control-panel/zomboid-control-panel), so EVERY sibling
// process on that host -- other vitest workers, an unrelated shell, the
// runner's own supervisor -- has "zomboid" somewhere in its own cwd-derived
// argv, none of them a PZ server. That made a genuinely idle CI runner
// report "unknown" on every single check, permanently -- worse than the bug
// being fixed, and exactly the regression this hunt's own dispatch warned
// against. The corrected fix (looksLikeUndeterminedJvmCandidate) requires
// BOTH "mentions zomboid/zombie.network" AND "looks like a JVM" (contains
// "java" as a substring) before treating a candidate as ambiguous evidence
// -- a vitest worker, shell, or backup script sitting in a zomboid-named
// directory is never going to have "java" in its own command line.
//
// Only mocks database/init.js (loadConfig()'s data source) and the logger
// (keep output quiet); pgrep/ps/spawn are all real, run against real
// background processes, matching this hunt's established pattern.

const isLinux = process.platform !== "win32";

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { ServerManager } = await import("../services/serverManager.js");

function makeManager(overrides) {
  const manager = new ServerManager();
  Object.assign(manager, { configLoaded: true, ...overrides });
  return manager;
}

(isLinux ? describe : describe.skip)(
  "getServerProcessDetails(): honest about scan uncertainty on Linux, without over-broadening",
  () => {
    let tmpDir;
    let fakeJava;
    let fakeNonJava;
    const spawnedPids = [];

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-scan-ambiguous-"));
      // Named exactly "java" (not "fake_java") deliberately -- matches the
      // real executable name a JVM invocation actually has, and exercises
      // looksLikeUndeterminedJvmCandidate's real \bjava\b word-boundary
      // match rather than an underscore-glued fixture name that would
      // never occur for a genuine `java` binary.
      fakeJava = path.join(tmpDir, "java");
      fs.writeFileSync(fakeJava, "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
      // Deliberately named to mention "zomboid" without being java-shaped
      // at all -- simulates the CI-runner sibling-process regression (a
      // vitest worker, a shell, a backup job sitting in a checkout whose
      // path happens to contain the repo's own name).
      fakeNonJava = path.join(tmpDir, "zomboid-control-panel-worker");
      fs.writeFileSync(fakeNonJava, "#!/bin/bash\nsleep 30\n", {
        mode: 0o755,
      });
    });

    afterEach(async () => {
      // 2026-08-30, flake-class-fixed-margin-sync: SIGKILL is delivered
      // asynchronously -- a killed process can still be visible in /proc for
      // a short window after this call returns, while the kernel finishes
      // tearing it down. This was previously masked by each test's own
      // fixed-300ms warmup wait incidentally giving the PREVIOUS test's
      // killed process time to be fully reaped too; removing that wait (see
      // waitUntilVisibleInProcTable above) exposed the gap as a real
      // cross-test race -- a later test's pgrep scan could still see an
      // earlier test's not-yet-reaped process and miscount `owned`. Wait for
      // the actual post-condition (gone from /proc) instead of assuming
      // SIGKILL is synchronous.
      while (spawnedPids.length) {
        const pid = spawnedPids.pop();
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
          continue;
        }
        const deadline = Date.now() + 5000;
        while (fs.existsSync(`/proc/${pid}`) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function spawnBg(execPath, args) {
      const proc = spawn(execPath, args, { detached: true, stdio: "ignore" });
      proc.unref();
      spawnedPids.push(proc.pid);
      return proc.pid;
    }

    // 2026-08-30, flake-class-fixed-margin-sync: this used to be a blind
    // `await new Promise(r => setTimeout(r, 300))` after spawnBg(), guessing
    // how long the OS takes to make a freshly-forked process visible to a
    // process-table scan. Under this floor's routine multi-agent CPU/process
    // contention, 300ms is not a guaranteed margin. getServerProcessDetails()
    // itself scans via pgrep/ps, both of which read from /proc on Linux, so
    // poll the exact same real signal (/proc/<pid> existing) instead of
    // guessing a duration -- deterministic, and no slower than the fixed
    // wait in the common case where the process is already visible.
    async function waitUntilVisibleInProcTable(pid, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          // cmdline (not just the pid directory) so a still-forking process
          // mid-exec doesn't count as "visible" a moment before pgrep/ps
          // would actually report it with real argv content.
          if (fs.readFileSync(`/proc/${pid}/cmdline`).length > 0) return;
        } catch {
          /* not there yet, or already gone -- keep polling until the deadline */
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Timed out waiting for pid ${pid} to appear in /proc`);
    }

    it("THE LIVE BUG: a -jar-style launch (a real, running PZ server the narrow matcher doesn't recognize) reports scanFailed:true, not a confident running:false", async () => {
      // "java" in its own path/name -- the real-world shape (java -jar
      // projectzomboid.jar) always has this, since it's a JVM.
      await waitUntilVisibleInProcTable(spawnBg(fakeJava, ["-jar", "projectzomboid.jar"]));

      const manager = makeManager({
        serverName: "NewServer",
        savePath: "/tmp/NewServerZomboid",
        serverPath: "/opt/NewServer",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(false);
      expect(details.scanFailed).toBe(true); // honest "unknown", not a confident wrong answer
    });

    it("THE CI REGRESSION: a non-java process whose own path/name merely mentions zomboid (a sibling test worker, a shell in a zomboid-named checkout) is discarded as noise, NOT treated as ambiguous evidence", async () => {
      await waitUntilVisibleInProcTable(spawnBg(fakeNonJava, []));

      const manager = makeManager({
        serverName: "IdleServer",
        savePath: "/tmp/IdleServerZomboid",
        serverPath: "/opt/IdleServer",
      });
      const details = await manager.getServerProcessDetails();

      // Must resolve exactly like a genuinely idle host: confidently
      // stopped, not "unknown". This is the assertion that failed on the
      // real GitHub Actions runner with the first version of this fix.
      expect(details.running).toBe(false);
      expect(details.scanFailed).toBe(false);
    });

    it("positive control: the panel's own generated-script shape is still confirmed normally (proves the fix didn't weaken real detection)", async () => {
      await waitUntilVisibleInProcTable(
        spawnBg(fakeJava, [
          "-Djava.library.path=natives/",
          "-cp",
          "java/.",
          "zombie.network.GameServer",
          "-servername",
          "GoodServer",
          "-cachedir=/tmp/GoodServerZomboid",
        ]),
      );

      const manager = makeManager({
        serverName: "GoodServer",
        savePath: "/tmp/GoodServerZomboid",
        serverPath: "/opt/GoodServer",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(true);
      expect(details.scanFailed).toBe(false);
      expect(details.owned).toHaveLength(1);
    });

    it("a genuinely idle host (nothing spawned at all) still reports confidently stopped -- the fix must not make every check say unknown", async () => {
      const manager = makeManager({
        serverName: "IdleServer2",
        savePath: "/tmp/IdleServer2Zomboid",
        serverPath: "/opt/IdleServer2",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(false);
      expect(details.scanFailed).toBe(false);
    });
  },
);
