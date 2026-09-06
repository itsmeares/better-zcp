import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// cleanupOldBackups (automatic, unattended, runs on a schedule) must never
// prune an "uploaded-" archive -- see its own comment in backupService.js.
// deleteBackupsOlderThan (operator-initiated, explicit) deliberately does
// the opposite and includes uploads. This proves both halves of that
// asymmetry against a REAL, isolated temp directory (real fs, not a mock
// of listBackups), plus that normal pruning still actually prunes -- a fix
// that "passes" by pruning nothing is the exact failure mode this program
// keeps producing.

const settings = new Map();

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async (key) => settings.get(key),
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  logServerEvent: async () => {},
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord: async () => {},
  removeBackupRecord: async () => {},
  listBackupRecords: async () => [],
}));

// Seeded with a real directory before the dynamic import below: importing
// backupService.js pulls in utils/logger.js, which calls getDataPaths()
// and mkdirSyncs a logs dir at MODULE IMPORT TIME (top-level, before any
// beforeEach runs) -- so tmpDir must already be a real path at that first
// import, not just non-undefined later. beforeEach swaps in a fresh one
// per test for isolation.
//
// initDir is kept as its OWN stable constant, separate from the mutable
// tmpDir below (ENOTEMPTY class, hunt-wave12, 2026-08-29/30): tmpDir gets
// reassigned by beforeEach, but logger.js's winston singleton resolved
// logsDir from THIS value, once, at the import a few lines down -- it
// never re-reads getDataPaths() afterward. No hook in this file ever
// deletes initDir, which is exactly why it used to leak a real winston
// logger's files forever (measured on this machine: 595 such directories
// from this file's prefix, every sampled one containing real
// combined.log/error.log). See the regression test at the bottom of this
// file.
const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-prune-seed-"));
let tmpDir = initDir;
vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

// ENOTEMPTY class (hunt-wave12, 2026-08-29/30): services/backupService.js
// imports utils/logger.js, so without this the real winston logger
// resolved its logsDir from initDir above and wrote real log files into it
// for the lifetime of this file's test run. Never the same directory any
// per-test afterEach deletes, so never an ENOTEMPTY risk the way
// modThumbnailResolution.test.js's race was (5d5a9088) -- but a real,
// separate, measured leak this mock closes. Matches the convention already
// established elsewhere in this suite.
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
    settings.set("backupMaxCount", 0); // force: keep zero plain backups
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

    // listBackups() reads birthtime, which Node cannot rewrite portably on
    // every supported filesystem. Supply old metadata while keeping the
    // actual deleteBackup() path and files real.
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

// ENOTEMPTY class regression (hunt-wave12, 2026-08-29/30): placed last so
// every test above has already run. Before the logger.js mock above, this
// failed -- initDir genuinely contained combined.log/error.log, measured
// directly on this machine. After it, nothing ever writes into initDir at
// all, so this stays green rather than decorative.
describe("ENOTEMPTY class regression: the module-load-time seed directory never receives real logger writes", () => {
  it("initDir (captured at the static import above, never deleted by any hook) contains no *.log files", () => {
    expect(
      fs.readdirSync(initDir).filter((f) => f.endsWith(".log")),
    ).toEqual([]);
  });
});
