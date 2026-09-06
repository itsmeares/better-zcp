import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Regression (2026-08-31 services sweep), two related deleteBackup()
// diagnostics bugs found in the same pass:
//
// 1. cleanupOldBackups() read `deleted?.error` to log why a backup could
//    not be cleaned up, but deleteBackup() only ever sets `.message` on
//    failure -- every real cleanup failure logged the same "unknown error"
//    string regardless of what actually went wrong.
// 2. deleteBackup()'s logServerEvent() call was the only side-effect call
//    in the function not wrapped in its own try/catch (removeBackupRecord
//    two lines above it is). A logging failure after the file was already
//    unlinked and the record already removed used to report success:false
//    for a backup that was in fact already gone.

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

vi.mock("../services/backupRecords.js", () => ({
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

vi.mock("../utils/logger.js", () => ({
  createLogger: () => mockLogger,
}));

// Same module-load-time seed-directory requirement as
// backupUploadPruneExemption.test.js -- importing backupService.js pulls in
// utils/logger.js's real getDataPaths() call at import time, before any
// beforeEach runs.
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
    // world_backup_1 is real and prunable; ghost_backup is listed but does
    // not actually exist on disk, forcing deleteBackup() to hit its real
    // "Backup not found" failure path (not a mock).
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
