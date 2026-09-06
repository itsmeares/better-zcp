import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { generateStartBat as generateStartBatForStaticChecks } from "../../../scripts/release/build.mjs";

describe("Start.bat never depends on the Get-FileHash cmdlet for staged-bundle integrity", () => {
  it("does not invoke Get-FileHash anywhere in the generated script", () => {
    expect(generateStartBatForStaticChecks()).not.toMatch(/Get-FileHash\s+-/);
  });
});

const isWindows = process.platform === "win32";
const CSC_PATH =
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const hasCsc = isWindows && fs.existsSync(CSC_PATH);
const skipReason = !isWindows
  ? `Windows-only supervisor test, running on ${process.platform}`
  : !hasCsc
    ? "legacy .NET Framework csc.exe not found -- cannot build the stub exe"
    : null;

function getShortPathName(longPath) {
  const batPath = path.join(os.tmpdir(), `pz-shortname-probe-${process.pid}-${Date.now()}.bat`);
  fs.writeFileSync(batPath, `@echo off\r\nfor %%I in ("${longPath}") do echo %%~sI\r\n`);
  try {
    return execFileSync("cmd.exe", ["/c", batPath], { encoding: "utf8" }).trim();
  } finally {
    fs.rmSync(batPath, { force: true });
  }
}

let shortNamesGeneratedOnTempVolume = false;
if (!skipReason) {
  const probeParent = fs.mkdtempSync(path.join(os.tmpdir(), "pz-shortname-probe-"));
  try {
    const probeLeaf = path.join(probeParent, "eightpointthreetestdirectory");
    fs.mkdirSync(probeLeaf);
    shortNamesGeneratedOnTempVolume =
      getShortPathName(probeLeaf).toLowerCase() !== probeLeaf.toLowerCase();
  } finally {
    fs.rmSync(probeParent, { recursive: true, force: true });
  }
}

const STUB_SOURCE = `
using System;
using System.IO;

// Controllable stand-in for ZomboidControlPanel.exe. Reads exit-codes.txt and
// sleep-ms.txt (one value per line, one per invocation; the last line
// repeats if invoked more times than there are lines) from its own
// directory, tracks its invocation count via a counter file, sleeps, then
// exits with the chosen code -- so a test can script a whole run history
// ("crash, crash, stay up, crash, clean exit") without touching the real
// panel binary.
class Stub {
  static int Main() {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string counterPath = Path.Combine(dir, "invoke-count.txt");
    int invocation = 0;
    if (File.Exists(counterPath)) {
      int.TryParse(File.ReadAllText(counterPath).Trim(), out invocation);
    }
    File.WriteAllText(counterPath, (invocation + 1).ToString());

    int code = ReadIndexed(Path.Combine(dir, "exit-codes.txt"), invocation, 0);
    int sleepMs = ReadIndexed(Path.Combine(dir, "sleep-ms.txt"), invocation, 0);

    if (sleepMs > 0) System.Threading.Thread.Sleep(sleepMs);
    Console.WriteLine("stub invocation " + invocation + " exiting with code " + code);
    return code;
  }

  static int ReadIndexed(string path, int index, int fallback) {
    if (!File.Exists(path)) return fallback;
    var lines = File.ReadAllLines(path);
    if (lines.Length == 0) return fallback;
    int i = index < lines.Length ? index : lines.Length - 1;
    int val;
    return int.TryParse(lines[i].Trim(), out val) ? val : fallback;
  }
}
`;

let sharedDir;
let stubExePath;
let generateStartBat;

async function writeStartBatInto(dir) {
  fs.writeFileSync(path.join(dir, "Start.bat"), generateStartBat());
}

function setupStub(dir, exitCodes, sleepMsList) {
  fs.copyFileSync(stubExePath, path.join(dir, "ZomboidControlPanel.exe"));
  fs.writeFileSync(path.join(dir, "exit-codes.txt"), exitCodes.join("\n"));
  fs.writeFileSync(
    path.join(dir, "sleep-ms.txt"),
    (sleepMsList || [0]).join("\n"),
  );
}

function sha256DirectoryForFixture(dirPath) {
  const pairs = [];
  const walk = (dir, rel) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else {
        const fileHash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(absolutePath))
          .digest("hex");
        pairs.push(`${relativePath}:${fileHash}`);
      }
    }
  };
  walk(dirPath, "");
  const parts = pairs.map((pair) => {
    const separatorIndex = pair.indexOf(":");
    const relativePath = pair.slice(0, separatorIndex);
    const fileHash = pair.slice(separatorIndex + 1);
    return `${relativePath}\0${fileHash}\n`;
  });
  const hash = crypto.createHash("sha256").update(parts.join(""), "utf8").digest("hex");
  return { hash, pairs };
}

function setupPendingUpdate(dir) {
  const stagedBinaryPath = path.join(dir, "ZomboidControlPanel.exe.new");
  fs.copyFileSync(stubExePath, stagedBinaryPath);

  const liveClientPath = path.join(dir, "client", "dist");
  const stagedClientPath = path.join(dir, "client", "dist.new-test");
  fs.mkdirSync(liveClientPath, { recursive: true });
  fs.mkdirSync(stagedClientPath, { recursive: true });
  fs.writeFileSync(path.join(liveClientPath, "index.html"), "old-client");
  fs.writeFileSync(path.join(stagedClientPath, "index.html"), "new-client");
  const binarySha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(stagedBinaryPath))
    .digest("hex");
  const { hash: clientSha256, pairs: clientFiles } = sha256DirectoryForFixture(stagedClientPath);
  fs.writeFileSync(
    path.join(dir, "update-bundle.json"),
    JSON.stringify({
      hashes: { binarySha256, clientSha256, clientFiles },
      paths: { stagedClient: stagedClientPath },
    }),
  );
  fs.writeFileSync(path.join(dir, ".update-pending"), "pending");
}

function denyDelete(targetPath) {
  execFileSync("icacls.exe", [targetPath, "/deny", "*S-1-1-0:(D)"], {
    stdio: "ignore",
  });
}

function allowDelete(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  execFileSync("icacls.exe", [targetPath, "/remove:d", "*S-1-1-0"], {
    stdio: "ignore",
  });
}

function holdFileOpenWithoutDelete(filePath, durationSeconds) {
  const psScript = `$fs = [System.IO.File]::Open('${filePath.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); Start-Sleep -Seconds ${durationSeconds}; $fs.Close()`;
  return spawn("powershell.exe", ["-NoProfile", "-Command", psScript], {
    windowsHide: true,
    stdio: "ignore",
  });
}

async function waitForCondition(check, timeoutMs, description, getDiagnostic) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const diagnostic = getDiagnostic ? `\n--- supervisor.log at timeout ---\n${getDiagnostic()}` : "";
  throw new Error(`Timed out waiting for ${description}${diagnostic}`);
}

function runSupervisor(dir, env, timeoutMs) {
  const childEnv = { ...process.env, ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === "nodefaultcurrentdirectoryinexepath") {
      delete childEnv[key];
    }
  }
  return new Promise((resolve) => {
    const child = spawn("cmd.exe", ["/c", path.join(dir, "Start.bat")], {
      cwd: dir,
      env: childEnv,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : code,
        signal: timedOut ? "SIGTERM" : null,
        stdout,
        stderr,
      });
    });
  });
}

function countLaunches(stdout) {
  return ((stdout || "").match(/^Launching /gm) || []).length;
}

function readSupervisorLog(dir) {
  const p = path.join(dir, "logs", "supervisor.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function readSupervisorLogWithJournalDiagnostic(dir) {
  const log = readSupervisorLog(dir);
  const journalPath = path.join(dir, "update-bundle.json");
  let journalFiles = "(update-bundle.json not present)";
  if (fs.existsSync(journalPath)) {
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      journalFiles = JSON.stringify(journal.hashes?.clientFiles ?? null);
    } catch (error) {
      journalFiles = `(could not parse update-bundle.json: ${error.message})`;
    }
  }
  return `${log}\n--- journal hashes.clientFiles (what Node hashed) ---\n${journalFiles}`;
}

function secondsBetweenLogLine(log, pattern) {
  const lines = log.split("\n").filter(Boolean);
  const idx = lines.findIndex((l) => pattern.test(l));
  if (idx === -1 || idx + 1 >= lines.length) return null;
  const stampOf = (line) => {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
    return m ? new Date(m[1].replace(" ", "T")) : null;
  };
  const from = stampOf(lines[idx]);
  const to = stampOf(lines[idx + 1]);
  if (!from || !to) return null;
  return (to.getTime() - from.getTime()) / 1000;
}

function freshScenarioDir(name) {
  const dir = path.join(sharedDir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe.skipIf(!!skipReason)(
  "Start.bat supervisor crash-loop behavior",
  () => {
    beforeAll(async () => {
      ({ generateStartBat } = await import("../../../scripts/release/build.mjs"));

      sharedDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pz-supervisor-test-"),
      );
      const srcPath = path.join(sharedDir, "stub.cs");
      fs.writeFileSync(srcPath, STUB_SOURCE);
      stubExePath = path.join(sharedDir, "ZomboidControlPanel.exe");
      execFileSync(
        CSC_PATH,
        ["-nologo", "-optimize", "-out:" + stubExePath, srcPath],
        { stdio: "pipe" },
      );

    }, 90000);

    afterAll(() => {
      if (sharedDir) fs.rmSync(sharedDir, { recursive: true, force: true });
    });

    it(
      "does not relaunch a clean exit (code 0)",
      async () => {
        const dir = freshScenarioDir("clean-exit");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);

        const result = await runSupervisor(dir, {}, 545000);

        expect(countLaunches(result.stdout)).toBe(1);
        expect(result.status).toBe(0);
        expect(readSupervisorLog(dir)).not.toMatch(/relaunch attempt/i);
      },
      560000,
    );

    it(
      "does not relaunch or crash-loop a deliberate refusal (code 78) -- retrying is pointless when another instance already holds the lock",
      async () => {
        const dir = freshScenarioDir("refused-second-instance");
        await writeStartBatInto(dir);
        setupStub(dir, [78], [0]);

        const result = await runSupervisor(dir, {}, 140000);

        expect(countLaunches(result.stdout)).toBe(1);
        expect(result.status).toBe(78);
        const log = readSupervisorLog(dir);
        expect(log).not.toMatch(/relaunch attempt/i);
        expect(log).not.toMatch(/Gave up/i);
      },
      155000,
    );

    it(
      "does not assert a URL it cannot actually know -- the panel prints its own real one",
      async () => {
        const dir = freshScenarioDir("no-hardcoded-url");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);

        const result = await runSupervisor(dir, {}, 80000);

        expect(result.status).toBe(0);
        expect(result.stdout).not.toMatch(/localhost:3001/);
      },
      95000,
    );

    it(
      "relaunches once after a crash, then stops cleanly once the panel recovers",
      async () => {
        const dir = freshScenarioDir("recover-after-crash");
        await writeStartBatInto(dir);
        setupStub(dir, [7, 0], [0, 0]);

        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          330000,
        );

        expect(countLaunches(result.stdout)).toBe(2);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/relaunch attempt 1 of 5/);
        expect(log).not.toMatch(/Gave up/);
      },
      345000,
    );

    it(
      "a non-zero backoff actually waits, not just claims to in the log -- the branch every other test in this file sets to 0 and skips",
      async () => {
        const dir = freshScenarioDir("real-backoff-wait");
        await writeStartBatInto(dir);
        setupStub(dir, [7, 0], [0, 0]);

        const result = await runSupervisor(dir, { PANEL_SUPERVISOR_BACKOFF_SECONDS: "3" }, 75000);

        expect(countLaunches(result.stdout)).toBe(2);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/relaunch attempt 1 of 5, waiting 3s/);
        const gapSeconds = secondsBetweenLogLine(log, /relaunch attempt 1 of 5, waiting 3s/);
        expect(gapSeconds, "measured gap between the wait message and the next launch").not.toBeNull();
        expect(gapSeconds).toBeGreaterThanOrEqual(2);
      },
      90000,
    );

    it(
      "stops and surfaces the exit code once repeated crashes exceed the cap",
      async () => {
        const dir = freshScenarioDir("hits-cap");
        await writeStartBatInto(dir);
        setupStub(dir, [7], [0]);

        const result = await runSupervisor(
          dir,
          {
            PANEL_SUPERVISOR_BACKOFF_SECONDS: "0",
            PANEL_SUPERVISOR_MAX_CRASHES: "3",
          },
          165000,
        );

        expect(countLaunches(result.stdout)).toBe(4);
        expect(result.status).toBe(7);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/relaunch attempt 1 of 3/);
        expect(log).toMatch(/relaunch attempt 2 of 3/);
        expect(log).toMatch(/relaunch attempt 3 of 3/);
        expect(log).toMatch(/Gave up after 4 rapid crashes/);
      },
      180000,
    );

    it(
      "still loops immediately on exit code 75 (update path), unaffected by the crash cap",
      async () => {
        const dir = freshScenarioDir("update-loop");
        await writeStartBatInto(dir);
        setupStub(dir, [75, 75, 0], [0, 0, 0]);

        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_MAX_CRASHES: "1" },
          95000,
        );

        expect(countLaunches(result.stdout)).toBe(3);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).not.toMatch(/relaunch attempt/);
        expect(log).not.toMatch(/Gave up/);
      },
      110000,
    );

    it(
      "refuses to apply a staged binary whose hash no longer matches the journal, instead of installing it over a working install",
      async () => {
        const dir = freshScenarioDir("staged-hash-mismatch");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        const stagedBinaryPath = path.join(dir, "ZomboidControlPanel.exe.new");
        const corrupted = fs.readFileSync(stagedBinaryPath);
        corrupted[corrupted.length - 1] ^= 0xff;
        fs.writeFileSync(stagedBinaryPath, corrupted);

        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          60000,
        );

        expect(countLaunches(result.stdout)).toBe(1);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/staged binary hash check \[MISMATCH[^\]]*\].*av_quarantine/i);
        expect(log).not.toMatch(/bundle activated/i);
        expect(
          fs.readFileSync(path.join(dir, "client", "dist", "index.html"), "utf8"),
        ).toBe("old-client");
        expect(
          fs.existsSync(
            path.join(dir, "ZomboidControlPanel.exe.bundle-previous"),
          ),
        ).toBe(false);
        expect(fs.existsSync(path.join(dir, ".update-pending"))).toBe(false);
      },
      75000,
    );

    it(
      "refuses to apply a staged client bundle whose hash no longer matches the journal, instead of installing it over a working install",
      async () => {
        const dir = freshScenarioDir("staged-client-hash-mismatch");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        const stagedClientIndexPath = path.join(
          dir,
          "client",
          "dist.new-test",
          "index.html",
        );
        fs.writeFileSync(stagedClientIndexPath, "tampered-client");

        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          60000,
        );

        expect(countLaunches(result.stdout)).toBe(1);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/staged frontend hash check \[MISMATCH[^\]]*\].*av_quarantine/i);
        expect(log).not.toMatch(/bundle activated/i);
        expect(
          fs.readFileSync(path.join(dir, "client", "dist", "index.html"), "utf8"),
        ).toBe("old-client");
        expect(
          fs.existsSync(
            path.join(dir, "ZomboidControlPanel.exe.bundle-previous"),
          ),
        ).toBe(false);
        expect(fs.existsSync(path.join(dir, ".update-pending"))).toBe(false);
      },
      75000,
    );

    it(
      "verifies the staged client bundle correctly even when its journal path has a trailing separator Resolve-Path does not strip",
      async () => {
        const dir = freshScenarioDir("client-noncanonical-path");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        const journalPath = path.join(dir, "update-bundle.json");
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
        const canonicalStagedClient = journal.paths.stagedClient;
        journal.paths.stagedClient = `${canonicalStagedClient}\\`;
        fs.writeFileSync(journalPath, JSON.stringify(journal));

        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          60000,
        );

        expect(result.status).toBe(0);
        const log = readSupervisorLogWithJournalDiagnostic(dir);
        expect(log).not.toMatch(/hash_unverifiable/i);
        expect(log).not.toMatch(/MISMATCH/i);
        expect(log).toMatch(/Apply: backing up/i);
      },
      75000,
    );

    it.skipIf(!shortNamesGeneratedOnTempVolume)(
      "verifies the staged client bundle correctly when its journal path is given in 8.3 short form while enumeration returns long-form paths",
      async () => {
        const dir = freshScenarioDir("shortname-mismatch");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        const journalPath = path.join(dir, "update-bundle.json");
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
        const longStagedClient = journal.paths.stagedClient;
        const shortStagedClient = getShortPathName(longStagedClient);
        expect(shortStagedClient.toLowerCase()).not.toBe(longStagedClient.toLowerCase());

        journal.paths.stagedClient = shortStagedClient;
        fs.writeFileSync(journalPath, JSON.stringify(journal));

        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          60000,
        );

        expect(result.status).toBe(0);
        const log = readSupervisorLogWithJournalDiagnostic(dir);
        expect(log).not.toMatch(/hash_unverifiable/i);
        expect(log).not.toMatch(/MISMATCH/i);
        expect(log).toMatch(/Apply: bundle activated/i);
      },
      75000,
    );

    it(
      "rolls back instead of launching when the pending marker cannot become the applying marker",
      async () => {
        const dir = freshScenarioDir("marker-move-failure");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        const markerPath = path.join(dir, ".update-pending");
        denyDelete(markerPath);
        const supervisor = runSupervisor(
          dir,
          {
            PANEL_SUPERVISOR_BACKOFF_SECONDS: "0",
            PANEL_SUPERVISOR_MAX_CRASHES: "1",
          },
          120000,
        );
        let result;
        try {
          await waitForCondition(
            () =>
              /could not move pending marker/i.test(readSupervisorLog(dir)),
            30000,
            "the supervisor to report the marker transition failure",
            () => readSupervisorLogWithJournalDiagnostic(dir),
          );
        } finally {
          allowDelete(markerPath);
          result = await supervisor;
        }

        expect(result.status).toBe(0);
        expect(countLaunches(result.stdout)).toBeGreaterThanOrEqual(1);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/could not move pending marker/i);
        expect(log).not.toMatch(/bundle activated; waiting/i);
        expect(fs.existsSync(path.join(dir, "ZomboidControlPanel.exe"))).toBe(true);
        expect(
          fs.readFileSync(path.join(dir, "client", "dist", "index.html"), "utf8"),
        ).toBe("old-client");
      },
      135000,
    );

    it(
      "retains the journal and reports an incomplete rollback when a backup cannot be restored",
      async () => {
        const dir = freshScenarioDir("denied-backup-restore");
        await writeStartBatInto(dir);
        setupStub(dir, [7, 0], [5000, 0]);
        setupPendingUpdate(dir);

        const backupPath = path.join(
          dir,
          "ZomboidControlPanel.exe.bundle-previous",
        );
        const supervisor = runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          120000,
        );
        let permissionApplied = false;
        let setupError;
        let result;
        try {
          await waitForCondition(
            () => fs.existsSync(backupPath),
            30000,
            "the binary backup to be created",
            () => readSupervisorLogWithJournalDiagnostic(dir),
          );
          denyDelete(backupPath);
          permissionApplied = true;
        } catch (error) {
          setupError = error;
        } finally {
          result = await supervisor;
          allowDelete(backupPath);
        }

        if (setupError) throw setupError;
        expect(permissionApplied).toBe(true);
        expect(result.status).toBe(1);
        expect(fs.existsSync(path.join(dir, "update-bundle.json"))).toBe(true);
        expect(fs.existsSync(path.join(dir, ".update-applying"))).toBe(true);
        expect(fs.existsSync(backupPath)).toBe(true);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/binary restore failed/i);
        expect(log).toMatch(/rollback incomplete; journal retained/i);
        expect(log).not.toMatch(/rollback complete/i);
      },
      135000,
    );

    it(
      "does not report a rollback failure when the frontend backup step itself never ran",
      async () => {
        const dir = freshScenarioDir("client-backup-never-ran");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        const liveClientPath = path.join(dir, "client", "dist");
        const lockedFilePath = path.join(liveClientPath, "index.html");
        const holder = holdFileOpenWithoutDelete(lockedFilePath, 25);
        const supervisor = runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          120000,
        );
        let result;
        try {
          await waitForCondition(
            () =>
              /could not back up live frontend/i.test(readSupervisorLog(dir)),
            30000,
            "the supervisor to report the client backup failure",
            () => readSupervisorLogWithJournalDiagnostic(dir),
          );
        } finally {
          holder.kill();
          result = await supervisor;
        }

        expect(result.status).toBe(0);
        expect(countLaunches(result.stdout)).toBeGreaterThanOrEqual(1);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/could not back up live frontend/i);
        expect(log).toMatch(
          /frontend restore skipped; backup step never ran/i,
        );
        expect(log).not.toMatch(/frontend restore failed/i);
        expect(log).not.toMatch(/rollback incomplete/i);
        expect(log).toMatch(/rollback complete/i);
        expect(
          fs.readFileSync(
            path.join(dir, "client", "dist", "index.html"),
            "utf8",
          ),
        ).toBe("old-client");
        expect(fs.existsSync(path.join(dir, ".update-pending"))).toBe(false);
        expect(fs.existsSync(path.join(dir, "update-bundle.json"))).toBe(
          false,
        );
      },
      135000,
    );

    it(
      "bounds the rollback-retry loop and halts visibly, naming the three recovery files, instead of looping forever",
      async () => {
        const dir = freshScenarioDir("rollback-retry-cap");
        await writeStartBatInto(dir);
        setupStub(dir, [1], [0]);
        setupPendingUpdate(dir);

        const backupPath = path.join(
          dir,
          "ZomboidControlPanel.exe.bundle-previous",
        );
        const supervisor = runSupervisor(
          dir,
          {
            PANEL_SUPERVISOR_BACKOFF_SECONDS: "0",
            PANEL_SUPERVISOR_MAX_ROLLBACK_RETRIES: "1",
          },
          60000,
        );
        let result;
        try {
          await waitForCondition(
            () => fs.existsSync(backupPath),
            30000,
            "the binary backup to be created",
            () => readSupervisorLogWithJournalDiagnostic(dir),
          );
          fs.rmSync(backupPath, { force: true });
        } finally {
          result = await supervisor;
        }

        expect(result.status).toBe(1);
        expect(countLaunches(result.stdout)).toBe(2);
        expect(fs.existsSync(path.join(dir, "ZomboidControlPanel.exe"))).toBe(
          true,
        );
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/binary restore failed; backup is missing/i);
        expect(log).toMatch(/retry 1 of 1/);
        expect(log).not.toMatch(/retry 2 of 1/);
        expect(log).toMatch(/rollback_retry_exhausted/);
        expect(result.stdout).toMatch(/\.update-pending/);
        expect(result.stdout).toMatch(/\.update-applying/);
        expect(result.stdout).toMatch(/update-bundle\.json/);
      },
      75000,
    );

    it(
      "resets the crash counter after a run that stays up long enough, so the cap never trips",
      async () => {
        const dir = freshScenarioDir("resets-after-stable-run");
        await writeStartBatInto(dir);
        setupStub(dir, [7, 7, 0], [0, 2500, 0]);

        const result = await runSupervisor(
          dir,
          {
            PANEL_SUPERVISOR_BACKOFF_SECONDS: "0",
            PANEL_SUPERVISOR_MAX_CRASHES: "1",
            PANEL_SUPERVISOR_MIN_STABLE_SECONDS: "1",
          },
          95000,
        );

        expect(countLaunches(result.stdout)).toBe(3);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/resetting crash counter/);
        expect(log).not.toMatch(/Gave up/);
      },
      110000,
    );
  },
);

if (skipReason) {
  it.skip(`Start.bat supervisor crash-loop behavior (skipped: ${skipReason})`, () => {});
}
