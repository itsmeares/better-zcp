import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

// Real modules (not mocked) — the globalSetup already redirects dataDir into
// a throwaway temp root for the whole suite, so this is safe to exercise
// against the real fs the same way circuitBreakerStatus.test.js does.
const { sweepOrphanedTmpFiles } = await import("../database/init.js");
const { getDataPaths } = await import("../utils/paths.js");

const { dataDir } = getDataPaths();

// Mirrors MIN_ORPHAN_AGE_MS in database/init.js with margin — not exported
// since it's an internal safety threshold, not part of the module's surface.
const OLD_ENOUGH_MS = 90_000;

function tmpFilePath(pid) {
  return path.join(dataDir, `db.json.${pid}.abc123.tmp`);
}

function writeTmpFile(pid, ageMs) {
  const filePath = tmpFilePath(pid);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ servers: [{ rconPassword: "leaked-secret-should-not-survive" }] }),
  );
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, old, old);
  }
  return filePath;
}

/** A pid guaranteed dead: spawn a trivial child and wait for it to exit. */
function getDeadPid() {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid;
}

function cleanupFixtures() {
  for (const name of fs.readdirSync(dataDir)) {
    if (/^db\.json\.\d+\.[0-9a-z]+\.tmp$/i.test(name)) {
      fs.rmSync(path.join(dataDir, name), { force: true });
    }
  }
}

describe("sweepOrphanedTmpFiles", () => {
  beforeEach(() => {
    cleanupFixtures();
  });

  afterEach(() => {
    cleanupFixtures();
  });

  it("removes a tmp file from a dead pid once it is old enough to be sure", () => {
    const filePath = writeTmpFile(getDeadPid(), OLD_ENOUGH_MS);
    sweepOrphanedTmpFiles();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("does NOT remove a tmp file belonging to a live process — the point of the whole sweep", () => {
    const filePath = writeTmpFile(process.pid, OLD_ENOUGH_MS);
    sweepOrphanedTmpFiles();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("does NOT remove a dead-pid tmp file that is too fresh to be sure", () => {
    const filePath = writeTmpFile(getDeadPid(), 0);
    sweepOrphanedTmpFiles();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("ignores files that don't match the write-temp naming pattern", () => {
    const decoyPath = path.join(dataDir, "db.json.notapid.abc123.tmp");
    fs.writeFileSync(decoyPath, "irrelevant");
    const old = new Date(Date.now() - OLD_ENOUGH_MS);
    fs.utimesSync(decoyPath, old, old);
    sweepOrphanedTmpFiles();
    expect(fs.existsSync(decoyPath)).toBe(true);
    fs.rmSync(decoyPath, { force: true });
  });

  // 2026-09-02, single-signal-sweep, REAL DEFECT fix: this sweep used to
  // carry its own local isPidAlive(), a THIRD undeduplicated copy of the
  // exact bug already fixed once in pidLock.js (bughunt-2026-08-31-c) --
  // it resolved any signal-0 probe error OTHER than EPERM to "dead",
  // instead of failing toward "still alive" for anything short of a
  // confirmed ESRCH. Now imports the shared, correctly-directioned
  // utils/pidLiveness.js isPidAlive() instead. This must NOT delete a tmp
  // file when the liveness probe is genuinely ambiguous (e.g. some
  // transient errno that is neither ESRCH nor EPERM) -- an ambiguous
  // signal should never authorise deleting a file a live writer might
  // still own.
  it("does NOT remove a tmp file when the pid-liveness probe is ambiguous (neither ESRCH nor EPERM)", () => {
    const filePath = writeTmpFile(999999, OLD_ENOUGH_MS);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("simulated ambiguous signal-0 probe failure");
      err.code = "EAGAIN";
      throw err;
    });
    try {
      sweepOrphanedTmpFiles();
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });
});
