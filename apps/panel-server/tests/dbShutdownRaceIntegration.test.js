import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

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
      const lockFd = fs.openSync(dbJsonPath, "r");
      const releaseAfterMs = 300;
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
      const lockFd = fs.openSync(dbJsonPath, "r");

      const exitPromise = new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
      const killedAt = Date.now();
      proc.kill("SIGTERM");
      const exitCode = await exitPromise;
      const elapsedMs = Date.now() - killedAt;

      fs.closeSync(lockFd);

      expect(exitCode).toBe(0);
      expect(elapsedMs).toBeLessThan(5000);
    },
    20000,
  );
  },
);
