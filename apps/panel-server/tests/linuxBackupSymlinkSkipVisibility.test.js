import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const logServerEvent = vi.fn(async () => {});

vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
}));

vi.mock("../routes/chunks.ts", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.ts");

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
      const seedService = createService();
      const seeded = await seedService.createBackup({ createPreRestoreBackup: false });
      expect(seeded.success).toBe(true);

      const restoreResult = await service.restoreBackup(seeded.backup.name, {
        createPreRestoreBackup: true,
      });

      expect(restoreResult.success).toBe(false);
      expect(restoreResult.message).toMatch(/pre-restore backup failed/i);
      expect(restoreResult.message).toMatch(/could not include/i);

      expect(fs.existsSync(path.join(savesPath, "map_meta.bin"))).toBe(true);
    },
  );
});
