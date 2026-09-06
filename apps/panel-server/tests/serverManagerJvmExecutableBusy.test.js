import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-30 Discord bug report (Rhazun): panel-initiated restart on Docker
// hung "verifying files" and looped forever; the decisive log line was a
// real "System.IO.IOException: Text file busy" (POSIX ETXTBSY) thrown while
// something tried to rewrite jre64/bin/java -- meaning the PREVIOUS java
// process was still alive and executing that exact file.
//
// Root cause: getServerProcessDetails()'s pgrep/ps scan only sees processes
// in the panel's OWN PID namespace. Our own docker-compose.yml explicitly
// recommends topologies where PZ runs outside that namespace (natively on
// the host, or in a separate container, reachable only via a bind-mounted
// install directory) -- in that shape, the scan reports a confident
// `running: false` even while the real PZ process is still alive and
// shutting down, so restartServer()'s "wait until confirmed dead" loop has
// nothing to wait on and starts a new JVM while the old one still holds its
// own binary open.
//
// isJvmExecutableBusy() asks the kernel the actual question ETXTBSY is
// about -- is this file currently busy -- which works regardless of PID
// namespace because it's a property of the inode, not the process table.
// These tests exercise it against a REAL executing file (a genuine spawned
// process, not a mock), because the whole point is a kernel-level guarantee
// that a fake/mocked fs call can't demonstrate.

const isLinux = process.platform !== "win32";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
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

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

(isLinux ? describe : describe.skip)(
  "ServerManager.isJvmExecutableBusy -- kernel-level ETXTBSY check",
  () => {
    let tmpDir;
    let javaPath;
    let child;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-jvm-busy-"));
      fs.mkdirSync(path.join(tmpDir, "jre64", "bin"), { recursive: true });
      javaPath = path.join(tmpDir, "jre64", "bin", "java");
      // A REAL ELF binary, not a shebang script -- ETXTBSY protection only
      // applies to the text segment the kernel actually maps and executes.
      // For a "#!/bin/sh" script, the kernel execve()s /bin/sh as the real
      // executable and just READS the script as a regular data argument, so
      // the script file itself is never ETXTBSY-protected -- only /bin/sh
      // would be. Copying a real binary (coreutils' sleep) and exec'ing it
      // directly reproduces the actual condition java.exe hits.
      fs.copyFileSync("/bin/sleep", javaPath);
      fs.chmodSync(javaPath, 0o755);
    });

    afterEach(async () => {
      if (child && child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      child = undefined;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("reports busy while the binary is genuinely being executed", async () => {
      const { spawn } = await import("child_process");
      child = spawn(javaPath, ["30"], {
        argv0: "sleep",
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      const manager = new ServerManager();
      manager.serverPath = tmpDir;

      expect(manager.isJvmExecutableBusy()).toBe(true);
    });

    it("clears once the process actually exits", async () => {
      const { spawn } = await import("child_process");
      child = spawn(javaPath, ["30"], {
        argv0: "sleep",
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      const manager = new ServerManager();
      manager.serverPath = tmpDir;
      expect(manager.isJvmExecutableBusy()).toBe(true);

      child.kill("SIGKILL");
      const cleared = await waitUntil(() => !manager.isJvmExecutableBusy());
      expect(cleared).toBe(true);
    });

    it("is not busy when the file exists but nothing is executing it", () => {
      const manager = new ServerManager();
      manager.serverPath = tmpDir;

      expect(manager.isJvmExecutableBusy()).toBe(false);
    });

    it("is not busy (best-effort false, not an error) when no jre64/jre directory exists at all", () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-jvm-busy-empty-"));
      try {
        const manager = new ServerManager();
        manager.serverPath = emptyDir;

        expect(manager.isJvmExecutableBusy()).toBe(false);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    // 2026-08-30, caught in review before this landed: two PZ servers
    // (differing only by -servername/-cachedir) sharing ONE install
    // directory to avoid a second multi-gigabyte copy is a normal,
    // already-accommodated deployment shape (db.data.servers has no
    // installPath uniqueness constraint; apps/panel-server/routes/server.js and
    // updateChecker.js both guard concurrent Steam operations by PATH, not
    // by server, for exactly this reason). isJvmExecutableBusy() can only
    // ever answer "is this file busy", not "is this MY server's old
    // process" -- so startServer() must never REFUSE on it the way
    // restartServer() does. Instead it waits a bounded amount (protecting
    // the manual Stop-then-Start workaround, where the busy-ness really is
    // this server's own not-quite-dead-yet process) and then proceeds
    // regardless -- launching a new process against a binary another
    // process is already executing is ordinary POSIX behavior (ETXTBSY is
    // about opening for WRITE, never a second execute), so "still busy"
    // after waiting is not evidence of anything wrong.
    it("startServer() proceeds (never throws the busy error) if the shared install's JVM binary stays busy the whole bounded wait -- that busy-ness may belong to an unrelated sibling server", async () => {
      const { spawn } = await import("child_process");
      child = spawn(javaPath, ["30"], {
        argv0: "sleep",
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      getActiveServer.mockResolvedValue({
        serverName: "JvmBusyTest",
        serverPath: tmpDir,
        serverBat: "start-server.sh",
        rconPort: 1,
      });

      const manager = new ServerManager();
      // No start-server.sh exists in this fixture, so startServer() still
      // fails -- but it must fail for THAT reason (after waiting out the
      // bound), never because of the busy JVM binary a sibling server is
      // legitimately holding open.
      await expect(
        manager.startServer({ skipRunningCheck: false }),
      ).rejects.not.toThrow(/Text file busy/);
    }, 10000);

    // Regression (2026-08-31, ordering-dependent-guards pass): this wait
    // used to live INSIDE the `if (!skipRunningCheck)` block, so
    // scheduler.js's performRestart() -- the only real production restart
    // path, which always calls startServer({skipRunningCheck: true}) since
    // it has already confirmed the old process stopped itself -- got ZERO
    // protection against the exact ETXTBSY race this file exists to guard,
    // reproducing Rhazun's original "Text file busy" crash through the one
    // code path that actually restarts a server. The test uses a deterministic
    // probe and a no-op sleep so it checks the loop without adding three
    // seconds to every server test run.
    it("startServer({skipRunningCheck: true}) ALSO waits for the busy binary to clear -- this is the flag scheduler.js's performRestart() actually uses", async () => {
      const { spawn } = await import("child_process");
      child = spawn(javaPath, ["30"], {
        argv0: "sleep",
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      getActiveServer.mockResolvedValue({
        serverName: "JvmBusyTest",
        serverPath: tmpDir,
        serverBat: "start-server.sh",
        rconPort: 1,
      });

      const manager = new ServerManager();
      // The real kernel probe is covered by the first three tests. This test
      // only needs a deterministic busy signal to verify the bounded wait is
      // also present on the skipRunningCheck=true restart path.
      vi.spyOn(manager, "isJvmExecutableBusy").mockReturnValue(true);
      const sleepSpy = vi
        .spyOn(manager, "sleep")
        .mockResolvedValue(undefined);
      await expect(
        manager.startServer({ skipRunningCheck: true }),
      ).rejects.not.toThrow(/Text file busy/);

      expect(sleepSpy).toHaveBeenCalledTimes(10);
      expect(sleepSpy).toHaveBeenCalledWith(300);
    }, 10000);

    it("startServer() stops waiting as soon as the binary frees, rather than always sleeping the full bound", async () => {
      getActiveServer.mockResolvedValue({
        serverName: "JvmBusyTest",
        serverPath: tmpDir,
        serverBat: "start-server.sh",
        rconPort: 1,
      });

      const manager = new ServerManager();
      vi.spyOn(manager, "getServerProcessDetails").mockResolvedValue({
        running: false,
        scanFailed: false,
      });
      // Model a probe that stays busy for two polls and then clears. The
      // real probe's transient kernel behavior is covered above; this keeps
      // the loop test deterministic and fast on every CI runner.
      vi.spyOn(manager, "isJvmExecutableBusy")
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      // gate-blocking-flaky-2026-08-31: this used to assert a wall-clock
      // bound (elapsedMs < 2500), which measured 3946ms on a busy machine
      // and failed the gate on a commit that never touched serverManager.js
      // -- a slow machine stretches EVERY component of this measurement
      // (spawning the child, each sleep(300) timer firing late under event
      // loop pressure), not just the thing the test is actually trying to
      // prove. Wall-clock elapsed can't distinguish "polled and exited
      // early, just slowly" from "always slept the full bound" once the
      // machine is slow enough.
      //
      // Assert the RELATIONSHIP the poll loop guarantees instead, via a
      // call-count on manager.sleep() -- immune to how fast or slow the
      // machine runs, because it counts loop iterations, not duration:
      //   - called MORE than once: proves this genuinely polled, not one
      //     single fixed-duration sleep standing in for the loop (a
      //     regression to "sleep the full bound instead of polling" calls
      //     sleep() exactly once).
      //   - called FEWER than the 10-attempt cap: proves it stopped as
      //     soon as the binary freed, instead of exhausting the full
      //     bound regardless of when the binary actually cleared.
      //   - every call used the real poll interval (300ms), not some
      //     other duration standing in for the loop.
      const sleepSpy = vi
        .spyOn(manager, "sleep")
        .mockResolvedValue(undefined);
      await expect(
        manager.startServer({ skipRunningCheck: false }),
      ).rejects.not.toThrow(/Text file busy/);

      const sleepCalls = sleepSpy.mock.calls;
      expect(sleepCalls.length).toBeGreaterThan(1);
      expect(sleepCalls.length).toBeLessThan(10);
      for (const call of sleepCalls) {
        expect(call[0]).toBe(300);
      }
    }, 10000);
  },
);

describe("ServerManager.isJvmExecutableBusy -- non-Linux / no-binary fallthrough", () => {
  it("is not busy when serverPath is empty (nothing configured yet)", () => {
    const manager = new ServerManager();
    manager.serverPath = "";

    expect(manager.isJvmExecutableBusy()).toBe(false);
  });
});
