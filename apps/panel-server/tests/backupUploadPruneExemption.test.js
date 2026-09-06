import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const settings = new Map();

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async (key) => settings.get(key),
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  logServerEvent: async () => {},
}));

vi.mock("../services/backupRecords.ts", () => ({
  addBackupRecord: async () => {},
  removeBackupRecord: async () => {},
  listBackupRecords: async () => [],
}));

const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-prune-seed-"));
let tmpDir = initDir;
vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { BackupService } = await import("../services/backupService.js");

function writeBackup(backupsPath, name) {
  fs.writeFileSync(path.join(backupsPath, name), "dummy");
}

function names(backupsPath) {
  return fs.readdirSync(backupsPath).filter((f) => f.endsWith(".zip"));
}

describe("backup pruning: uploaded archives are exempt from automatic prune, not from an explicit one", () => {
  let service;
  let backupsPath;

  beforeEach(async () => {
    settings.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-prune-"));
    service = new BackupService();
    backupsPath = await service.getBackupsPath();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleanupOldBackups: uploaded archives survive a prune that would have taken every plain backup", async () => {
    settings.set("backupMaxCount", 0);
    writeBackup(backupsPath, "uploaded-important.zip");
    writeBackup(backupsPath, "uploaded-another.zip");
    writeBackup(backupsPath, "world_backup_1.zip");
    writeBackup(backupsPath, "world_backup_2.zip");
    writeBackup(backupsPath, "world_backup_3.zip");

    await service.cleanupOldBackups();

    const remaining = names(backupsPath);
    expect(remaining).toEqual(
      expect.arrayContaining(["uploaded-important.zip", "uploaded-another.zip"]),
    );
    expect(remaining.some((n) => n.startsWith("world_backup_"))).toBe(false);
  });

  it("cleanupOldBackups: panel-created backups are still pruned correctly when there are no uploads at all", async () => {
    settings.set("backupMaxCount", 1);
    writeBackup(backupsPath, "world_backup_1.zip");
    writeBackup(backupsPath, "world_backup_2.zip");
    writeBackup(backupsPath, "world_backup_3.zip");

    await service.cleanupOldBackups();

    expect(names(backupsPath)).toHaveLength(1);
  });

  it("deleteBackupsOlderThan: an explicit, operator-initiated cutoff DOES delete uploaded archives -- unlike the automatic prune above", async () => {
    writeBackup(backupsPath, "uploaded-important.zip");
    writeBackup(backupsPath, "world_backup_1.zip");

    const oldCreated = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    service.listBackups = async () => [
      { name: "uploaded-important.zip", created: oldCreated },
      { name: "world_backup_1.zip", created: oldCreated },
    ];
    const result = await service.deleteBackupsOlderThan(1);

    expect(result.deleted).toBe(2);
    expect(names(backupsPath)).toHaveLength(0);
  });

  it("deleteBackupsOlderThan: a cutoff nothing is older than deletes nothing, uploads included", async () => {
    writeBackup(backupsPath, "uploaded-important.zip");
    writeBackup(backupsPath, "world_backup_1.zip");

    const result = await service.deleteBackupsOlderThan(9999);

    expect(result.deleted).toBe(0);
    expect(names(backupsPath)).toHaveLength(2);
  });
});

describe("ENOTEMPTY class regression: the module-load-time seed directory never receives real logger writes", () => {
  it("initDir (captured at the static import above, never deleted by any hook) contains no *.log files", () => {
    expect(
      fs.readdirSync(initDir).filter((f) => f.endsWith(".log")),
    ).toEqual([]);
  });
});
