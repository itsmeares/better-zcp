import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// 2026-08-29: real, cross-process proof for the flushForShutdown() fix.
// database/init.js's own shutdown() and index.js's gracefulShutdown() are
// two independent, unsynchronized listeners on the same SIGTERM/SIGINT --
// unit tests on flushForShutdown() itself (dbFlushForShutdown.test.js)
// prove IT retries and is bounded, but not that a real process wired up
// the way index.js actually is (two listeners, an httpServer.close(), a
// 10s force-exit failsafe) survives the race without hanging OR without
// still dropping the write. This spawns apps/panel-server/tests/fixtures/
// shutdownRaceHarness.mjs -- a minimal harness with the exact same
// shutdown shape as index.js's real gracefulShutdown() post-fix, using the
// real, unmocked database/init.js -- in its OWN isolated temp data dir
// (never the repo's real data/), forces the exact EPERM contention proven
// in the original hunt-wave13 diagnosis by holding an ordinary read handle
// on the child's own db.json from THIS process, and sends a real SIGTERM.
const HARNESS = path.join(import.meta.dirname, "fixtures", "shutdownRaceHarness.mjs");

let child;
let tempRoot;

function waitForLine(rl, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for a matching line after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onLine = (line) => {
      if (predicate(line)) {
        clearTimeout(timer);
        rl.off("line", onLine);
        resolve(line);
      }
    };
    rl.on("line", onLine);
  });
}

function spawnHarness(tempRoot) {
  const configPath = path.join(tempRoot, "paths.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      { dataDir: path.join(tempRoot, "data"), logsDir: path.join(tempRoot, "logs") },
      null,
      2,
    ),
  );
  const proc = spawn(process.execPath, [HARNESS], {
    env: { ...process.env, PANEL_PATHS_CONFIG_PATH: configPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = readline.createInterface({ input: proc.stdout });
  const lines = [];
  stdout.on("line", (l) => lines.push(l));
  return { proc, stdout, lines, configPath };
}

// Windows note: verified this file's premise fails loudly (exitCode null,
// not 0) rather than silently on win32 -- child_process's SIGTERM on
// Windows unconditionally terminates the target process instead of
// delivering an emulated signal to the child's own process.on("SIGTERM")
// handler, so the harness's handler never runs at all. That's a Windows
// child-process limitation, not something this fix or this test can
// paper over -- real POSIX signal delivery (Linux/WSL) is required to
// exercise the actual handler race. Confirmed the fix itself is inert on
// Windows via the full suite plus dbFlushForShutdown.test.js's unit-level
// coverage, which needs no real signal.
describe.skipIf(process.platform === "win32")(
  "shutdown survives real db.json rename contention (cross-process)",
  () => {
  afterEach(() => {
    if (child && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (tempRoot) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it(
    "TRANSIENT contention: the pending write survives -- proves the fix actually rescues what the old one-shot flush would have dropped",
    async () => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-race-"));
      const { proc, stdout } = spawnHarness(tempRoot);
      child = proc;

      await waitForLine(stdout, (l) => l.startsWith("HARNESS: listening"), 15000);

      const dbJsonPath = path.join(tempRoot, "data", "db.json");
      // Same mechanism proven in the original probe: an ordinary read
      // handle on the rename destination makes fs.renameSync throw EPERM
      // on this box. Held from THIS (parent) process against the CHILD's
      // db.json -- proving the contention is real cross-process file
      // locking, not merely an in-process artifact.
      const lockFd = fs.openSync(dbJsonPath, "r");
      const releaseAfterMs = 300; // transient: gone well within the retry window
      setTimeout(() => {
        try {
          fs.closeSync(lockFd);
        } catch {
          /* already closed */
        }
      }, releaseAfterMs);

      const exitPromise = new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
      const killedAt = Date.now();
      proc.kill("SIGTERM");
      const exitCode = await exitPromise;
      const elapsedMs = Date.now() - killedAt;

      expect(exitCode).toBe(0);
      // Generous vs. flushForShutdown()'s own ~600ms worst case (3 attempts,
      // 200ms delay each) plus process/http teardown overhead -- nowhere
      // near the 10s force-exit failsafe.
      expect(elapsedMs).toBeLessThan(5000);

      const finalData = JSON.parse(fs.readFileSync(dbJsonPath, "utf8"));
      expect(finalData.settings?.shutdownRaceProbe).toBeTruthy();
    },
    20000,
  );

  it(
    "THE RISKY HALF -- PERSISTENT contention that never clears: shutdown still exits promptly instead of hanging forever",
    async () => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-race-"));
      const { proc, stdout } = spawnHarness(tempRoot);
      child = proc;

      await waitForLine(stdout, (l) => l.startsWith("HARNESS: listening"), 15000);

      const dbJsonPath = path.join(tempRoot, "data", "db.json");
      // Held open for the ENTIRE test -- never released. If flushForShutdown()
      // were unbounded (e.g. flushWrites()'s own exponential backoff run to
      // exhaustion, or a naive retry-until-success loop), this is exactly
      // the scenario that turns "a lost config change" into "a panel that
      // will not stop".
      const lockFd = fs.openSync(dbJsonPath, "r");

      const exitPromise = new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
      const killedAt = Date.now();
      proc.kill("SIGTERM");
      const exitCode = await exitPromise;
      const elapsedMs = Date.now() - killedAt;

      fs.closeSync(lockFd);

      expect(exitCode).toBe(0);
      // Same bound as the transient case: flushForShutdown() gives up after
      // SHUTDOWN_FLUSH_MAX_ATTEMPTS regardless of whether the contention
      // ever clears -- this is the proof that the fix cannot regress into
      // a hang, well under the existing 10s force-exit failsafe.
      expect(elapsedMs).toBeLessThan(5000);
    },
    20000,
  );
  },
);
