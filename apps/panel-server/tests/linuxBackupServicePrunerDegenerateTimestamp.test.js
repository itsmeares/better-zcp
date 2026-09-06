import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-29 hunt (god): backup-and-restore, suspect 4 (retention/pruning).
// Same root cause already fixed once in configBackup.js's listBackupsFor()
// (see apps/panel-server/tests/linuxBackupPrunerDegenerateTimestamp.test.js) -- this
// is the sibling case for backupService.js's own, SEPARATE
// listBackups()/cleanupOldBackups(), which never got the same fix and was
// explicitly checked-and-left in a prior round on the theory that real
// full-server zip backups always take real wall-clock seconds to create,
// so same-tick birthtime collisions were unreachable in practice.
//
// That theory has a real hole: a fast or near-empty world (a freshly
// configured server, a test/staging box, or simply a small save) can
// complete a full createBackup() well under a second, and createBackup()'s
// own backupInProgress mutex means back-to-back backups (a manual click
// immediately followed by a scheduled fire, or two rapid manual clicks)
// serialize rather than overlap -- which is exactly what makes them land
// close enough in wall-clock time to tie on filesystems with coarser
// birthtime resolution (a real, if lower-probability, way to reach the bug
// this exact pattern already caused once in the sibling file). Since
// backupService.js's own filenames already embed a millisecond timestamp
// (`_doCreateBackup`'s `${serverName}_${timestamp}[-collision].zip`), the
// fix is the same one: sort by that instead of fs birthtime. This test
// forces the degenerate case directly (every stat() call returns an
// identical birthtime) rather than depending on hitting it by real timing,
// so it stays meaningful on every platform.

const logServerEvent = vi.fn(async () => {});
const settingsStore = new Map();

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async (key) => settingsStore.get(key) ?? null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

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
    // 10 pre-existing backups, oldest-to-newest by their OWN embedded
    // timestamp -- this ordering is the only signal the fix is allowed to
    // use, matching configBackup.js's own degenerate-timestamp test.
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
      // Every candidate, regardless of when it was actually written,
      // reports the SAME birthtime -- the worst case this pattern can
      // produce on a real filesystem.
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

    // The brand-new backup must survive pruning regardless of what fs.stat
    // reports for anyone's birthtime.
    expect(remaining).toContain(newBackupName);
    // And the pruner must still drop the TRUE oldest seed (by its own
    // embedded timestamp), not an arbitrary one picked by readdir order.
    expect(remaining).not.toContain("servertest_2026-08-20T00-00-00-000.zip");
    for (let i = 1; i < 10; i++) {
      expect(remaining).toContain(`servertest_2026-08-2${i}T00-00-00-000.zip`);
    }
  });
});
