import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


let logServerEventShouldThrow = false;

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
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
vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

const { BackupService } = await import("../services/backupService.js");

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
});
