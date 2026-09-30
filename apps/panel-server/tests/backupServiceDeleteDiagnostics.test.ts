import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";


let logServerEventShouldThrow = false;

vi.mock("../database/init.ts", () => ({
  getCurrentServer: async () => null,
  getSetting: async () => undefined,
  setSetting: async () => {},
  logServerEvent: async () => {
    if (logServerEventShouldThrow) {
      throw new Error("db write failed");
    }
  },
}));

vi.mock("../services/backupRecords.ts", () => ({
  addBackupRecord: async () => {},
  removeBackupRecord: async () => {},
  listBackupRecords: async () => [],
}));

const { warnCalls, mockLogger } = vi.hoisted(() => {
  const warnCalls = [];
  return {
    warnCalls,
    mockLogger: {
      info: () => {},
      warn: (msg) => warnCalls.push(msg),
      error: () => {},
      debug: () => {},
    },
  };
});

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => mockLogger,
}));

const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-delete-diag-seed-"));
let tmpDir = initDir;
vi.mock("../utils/paths.ts", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

const { BackupService } = await import("../services/backupService.ts");

function writeBackup(backupsPath, name) {
  fs.writeFileSync(path.join(backupsPath, name), "dummy");
}

describe("BackupService.deleteBackup() diagnostics", () => {
  let service;
  let backupsPath;

  beforeEach(async () => {
    logServerEventShouldThrow = false;
    warnCalls.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-delete-diag-"));
    service = new BackupService();
    backupsPath = await service.getBackupsPath();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleanupOldBackups logs deleteBackup's real failure reason, not a constant 'unknown error'", async () => {
    writeBackup(backupsPath, "world_backup_1.zip");
    service.listBackups = async () => [
      { name: "ghost_backup.zip", created: new Date(0).toISOString() },
      { name: "world_backup_1.zip", created: new Date(1).toISOString() },
    ];
    service.getSettings = async () => ({ maxBackups: 0 });

    await service.cleanupOldBackups();

    expect(warnCalls.some((m) => m.includes("Backup not found"))).toBe(true);
    expect(warnCalls.some((m) => m.includes("unknown error"))).toBe(false);
  });

  it("still reports success when the backup is genuinely gone but logServerEvent fails", async () => {
    writeBackup(backupsPath, "world_backup_1.zip");
    logServerEventShouldThrow = true;

    const result = await service.deleteBackup("world_backup_1.zip");

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(backupsPath, "world_backup_1.zip"))).toBe(false);
  });

  it("retention deletes from the backup's profile even when another profile has the same filename", async () => {
    const a = { id: "A", zomboidDataPath: path.join(tmpDir, "A") };
    const b = { id: "B", zomboidDataPath: path.join(tmpDir, "B") };
    const aPath = await service.getBackupsPath(a);
    const bPath = await service.getBackupsPath(b);
    writeBackup(aPath, "same.zip");
    writeBackup(bPath, "same.zip");
    service.getSettings = async () => ({ maxBackups: 0 });

    await service.cleanupOldBackups(a);

    expect(fs.existsSync(path.join(aPath, "same.zip"))).toBe(false);
    expect(fs.existsSync(path.join(bPath, "same.zip"))).toBe(true);
  });

  it("retention preserves another world's archive when profiles share a data folder", async () => {
    const a = { id: "A", serverName: "World", zomboidDataPath: tmpDir };
    const sharedPath = await service.getBackupsPath(a);
    const own = "World_2026-09-01T00-00-00-000.zip";
    const other = "World_Extra_2026-09-01T00-00-00-000.zip";
    writeBackup(sharedPath, own);
    writeBackup(sharedPath, other);
    service.getSettings = async () => ({ maxBackups: 0 });

    await service.cleanupOldBackups(a);

    expect(fs.existsSync(path.join(sharedPath, own))).toBe(false);
    expect(fs.existsSync(path.join(sharedPath, other))).toBe(true);
  });
});
