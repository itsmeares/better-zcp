import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-29, config hunt follow-up. Pam found writeFileAtomic's own
// .{filename}.{pid}.{random}.tmp orphans (left behind only when the
// process dies between the write and the rename/unlink that normally
// follows) have no sweep anywhere -- cosmetic, correctly not fixed there
// since it was outside her grant. This proves the sweep added to
// writeFileAtomic in fileWriteQueue.js: a dead pid's orphan is removed on
// the next write into the SAME directory; a live pid's is never touched,
// even though it matches the exact same filename shape.
const { writeFileAtomic } = await import("../utils/fileWriteQueue.js");

function makeDeadPid() {
  // A real pid guaranteed to have exited by the time this returns --
  // spawnSync only returns once the child is gone, so its pid cannot
  // legitimately be "alive" a moment later. Far more honest than guessing
  // a large unused number, which the OS could coincidentally reuse.
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid;
}

function orphanName(basename, pid) {
  return `.${basename}.${pid}.k3f9zq.tmp`;
}

describe("writeFileAtomic: sweeps its own orphaned temps, but only ones nobody could still be writing", () => {
  let dir;
  let targetPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-write-atomic-orphan-"));
    targetPath = path.join(dir, "config.ini");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes an orphaned temp left by a dead pid on the next write into that directory", () => {
    const deadPid = makeDeadPid();
    const orphan = path.join(dir, orphanName("config.ini", deadPid));
    fs.writeFileSync(orphan, "half-written-before-a-crash");
    expect(fs.existsSync(orphan)).toBe(true);

    writeFileAtomic(targetPath, "fresh-content");

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("fresh-content");
  });

  it("never removes a temp whose pid is still running, even though it matches the exact same name shape", () => {
    // Our own pid -- unambiguously alive for the duration of this test.
    const liveOrphan = path.join(dir, orphanName("config.ini", process.pid));
    fs.writeFileSync(liveOrphan, "a write genuinely still in flight");

    writeFileAtomic(targetPath, "fresh-content");

    expect(fs.existsSync(liveOrphan)).toBe(true);
    expect(fs.readFileSync(liveOrphan, "utf-8")).toBe("a write genuinely still in flight");
  });

  it("leaves unrelated dotfiles and backupService.js's own .central-*.tmp pattern alone", () => {
    const unrelated = path.join(dir, ".some-other-tool-state.tmp");
    const backupsCentral = path.join(dir, ".central-1234567-9876-abcdef.tmp");
    fs.writeFileSync(unrelated, "not ours");
    fs.writeFileSync(backupsCentral, "not ours either -- a different subsystem's pattern");

    writeFileAtomic(targetPath, "fresh-content");

    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(backupsCentral)).toBe(true);
  });
});
