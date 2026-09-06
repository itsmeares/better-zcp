import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { cleanupOrphanBackupTemps, isBackupTempOwnerAlive } from "../services/backupService.js";

// hunt-wave11-2026-08-29 follow-up. Dwight found this while copying
// cleanupOrphanBackupTemps as the model for fileWriteQueue.js's own sweep
// (531dfd8d) -- his copy came out stronger than the original. The original
// deleted on FILENAME PATTERN ALONE, with no check that the process which
// created a match is actually gone. Safe TODAY only because backups are
// effectively single-flight -- an assumption resting OUTSIDE this function
// rather than a guarantee inside it. This proves the fix applies
// fileWriteQueue.js's model (process.kill(pid, 0), any outcome other than
// a confirmed ESRCH treated as "still alive") to the ONE pattern that
// actually embeds a pid (.central-{pid}-{timestamp}-{random}.tmp,
// StreamingZipWriter's own construction, apps/panel-server/utils/streamingZip.js),
// while *.zip.tmp (no pid anywhere in its name) stays exactly as before --
// two patterns, deliberately not one generalised mechanism.

function makeDeadPid() {
  // A real pid guaranteed to have exited by the time this returns --
  // spawnSync only returns once the child is gone, so its pid cannot
  // legitimately be "alive" a moment later. Same technique as
  // writeFileAtomicOrphanTempSweep.test.js's makeDeadPid().
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid;
}

function centralName(pid) {
  return `.central-${pid}-1735500000000-k3f9zq.tmp`;
}

describe("isBackupTempOwnerAlive", () => {
  it("is true for this process's own, unambiguously running pid", () => {
    expect(isBackupTempOwnerAlive(process.pid)).toBe(true);
  });

  it("is false for a pid confirmed to have already exited (ESRCH)", () => {
    expect(isBackupTempOwnerAlive(makeDeadPid())).toBe(false);
  });
});

describe("cleanupOrphanBackupTemps", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-orphan-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes a .central-*.tmp orphan whose pid is confirmed dead", () => {
    const orphan = path.join(dir, centralName(makeDeadPid()));
    fs.writeFileSync(orphan, "half-written before a crash");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("NEVER removes a .central-*.tmp file whose pid is still running, even though it matches the exact same name shape -- the bug Dwight found", () => {
    // Our own pid -- unambiguously alive for the duration of this test.
    const liveOrphan = path.join(dir, centralName(process.pid));
    fs.writeFileSync(liveOrphan, "a backup genuinely still in flight");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(liveOrphan)).toBe(true);
    expect(fs.readFileSync(liveOrphan, "utf-8")).toBe(
      "a backup genuinely still in flight",
    );
  });

  it("*.zip.tmp is still removed unconditionally -- no pid to check, pattern-only deletion is unchanged for this pattern", () => {
    const zipTemp = path.join(dir, "some-backup.zip.tmp");
    fs.writeFileSync(zipTemp, "partial archive");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(zipTemp)).toBe(false);
  });

  it("a malformed .central-*.tmp name that doesn't embed a real pid is left alone, not swept on a lenient match -- 'fail toward leave it alone'", () => {
    // Not shaped like StreamingZipWriter's real output at all (no numeric
    // pid segment) -- liveness genuinely cannot be determined for this, so
    // the safe direction is to leave it, not delete it on a loose prefix
    // match the way the pre-fix regex (/^\.central-.*\.tmp$/) would have.
    const malformed = path.join(dir, ".central-not-a-real-pid.tmp");
    fs.writeFileSync(malformed, "not a real StreamingZipWriter temp");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(malformed)).toBe(true);
  });

  it("leaves unrelated files alone", () => {
    const unrelated = path.join(dir, "notes.txt");
    fs.writeFileSync(unrelated, "not ours");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
