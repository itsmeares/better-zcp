import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const logServerEvent = vi.fn(async () => {});
const settingsStore = new Map();

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async (key) => settingsStore.get(key) ?? null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
}));

vi.mock("../routes/chunks.ts", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.ts");

let root;
let savesPath;
let backupsPath;

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  return service;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backupservice-pruner-degenerate-"));
  savesPath = path.join(root, "Saves", "Multiplayer", "servertest");
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.mkdirSync(savesPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "seed");
  settingsStore.clear();
  settingsStore.set("backupMaxCount", 10);
  logServerEvent.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("BackupService pruning under a degenerate (all-identical) fs birthtime", () => {
  it("keeps the brand-new backup and drops the TRUE oldest (by its own embedded timestamp), not an arbitrary one", async () => {
    for (let i = 0; i < 10; i++) {
      const ts = `2026-08-2${i}T00-00-00-000`;
      fs.writeFileSync(
        path.join(backupsPath, `servertest_${ts}.zip`),
        `seed ${i}`,
      );
    }

    const service = createService();
    const createResult = await service.createBackup({
      createPreRestoreBackup: false,
    });
    expect(createResult.success).toBe(true);
    const newBackupName = createResult.backup.name;

    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, "stat").mockImplementation(async (p) => {
      const real = await realStat(p);
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        birthtimeMs: 0,
        birthtime: new Date(0),
      });
    });

    await service.cleanupOldBackups();

    const remaining = fs
      .readdirSync(backupsPath)
      .filter((f) => f.endsWith(".zip"));
    expect(remaining).toHaveLength(10);

    expect(remaining).toContain(newBackupName);
    expect(remaining).not.toContain("servertest_2026-08-20T00-00-00-000.zip");
    for (let i = 1; i < 10; i++) {
      expect(remaining).toContain(`servertest_2026-08-2${i}T00-00-00-000.zip`);
    }
  });
});
