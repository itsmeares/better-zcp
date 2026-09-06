import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-29 hunt (god): backup-and-restore, suspects 2 (what's excluded)
// and 3 (symlinks through the archive round trip).
//
// walkDirectory() deliberately never follows a symbolic link into the
// archive (confirmed still correct and unchanged by
// apps/panel-server/tests/backupRestoreSafety.test.js's own "does not follow symbolic
// links outside the save directory" test -- a symlink pointing outside the
// save tree must never leak arbitrary filesystem content into a backup).
// But that decision used to be invisible: it was a plain `continue` inside
// the generator, so the symlink never reached appendDirectoryToArchive()
// at all, and the ONLY existing tracking mechanism -- the skippedFiles
// array createBackup() already builds for files that vanish mid-archive
// (ENOENT) -- never saw it either. Two exclusion reasons the same subsystem
// already treats identically at every consumer (the "any skip is a
// failure" policy at restoreBackup()'s pre-restore backup, and the same at
// /wipe's pre-wipe backup) were tracked completely asymmetrically: one
// surfaced, one silent. A save tree containing a symlink could produce an
// "incomplete" pre-restore backup that read success:true with an EMPTY
// skippedFiles, defeating the exact safety net that policy exists to
// provide.
//
// This pins both: the symlink is still excluded (unchanged, still proven
// by the sibling test in backupRestoreSafety.test.js), AND it now shows up
// in skippedFiles like any other excluded entry, AND that visibility
// actually changes restoreBackup()'s pre-restore-backup safety decision.

const logServerEvent = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

const SERVER_NAME = "servertest";
let root;
let savesPath;
let backupsPath;

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.setServerManager({
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  });
  return service;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-symlink-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.mkdirSync(savesPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "real save content");
  logServerEvent.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createBackup(): a symbolic link inside the save tree is tracked as a skip, not silently dropped", () => {
  it.skipIf(process.platform === "win32")(
    "reports the symlink's archive path in skippedFiles",
    async () => {
      const outsideTarget = path.join(root, "outside-secret.txt");
      fs.writeFileSync(outsideTarget, "not part of the save");
      fs.symlinkSync(outsideTarget, path.join(savesPath, "sneaky-link.txt"));

      const service = createService();
      const result = await service.createBackup({ createPreRestoreBackup: false });

      expect(result.success).toBe(true);
      expect(result.skippedFiles).toContain(`${SERVER_NAME}/sneaky-link.txt`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "restoreBackup() refuses its mandatory pre-restore backup when the live save contains a symlink, instead of treating a silently-incomplete backup as safe",
    async () => {
      fs.symlinkSync(
        path.join(root, "some-target-outside-the-tree"),
        path.join(savesPath, "dangling-or-external-link"),
      );

      const service = createService();
      // Seed a restorable backup first so restoreBackup() gets past its
      // own file-lookup step and actually reaches the pre-restore-backup
      // step under test.
      const seedService = createService();
      const seeded = await seedService.createBackup({ createPreRestoreBackup: false });
      expect(seeded.success).toBe(true);

      const restoreResult = await service.restoreBackup(seeded.backup.name, {
        createPreRestoreBackup: true,
      });

      expect(restoreResult.success).toBe(false);
      expect(restoreResult.message).toMatch(/pre-restore backup failed/i);
      expect(restoreResult.message).toMatch(/could not include/i);

      // And the live save must be completely untouched -- the whole point
      // of refusing before ever extracting anything.
      expect(fs.existsSync(path.join(savesPath, "map_meta.bin"))).toBe(true);
    },
  );
});
