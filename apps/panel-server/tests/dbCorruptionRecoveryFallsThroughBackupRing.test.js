import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-09-03, destructive-paths-sweep: getDb()'s corruption-recovery path
// used to try exactly ONE backup -- getLatestBackup() -- and, if THAT one
// also failed to read, gave up and reset straight to defaultData: every
// setting, server and user discarded, even when older backups (pruneBackups
// only evicts past MAX_BACKUPS=5, so several usually exist) were sitting
// right next to it, untried. Concrete trigger: any event that corrupts more
// than one file close in time (an ENOSPC hit mid-write on db.json AND the
// backup written moments before it, a bad sector, a botched fsck) -- not
// far-fetched given createBackup() runs right alongside flushWrites().
//
// Fix: recovery now walks the backup ring newest-to-oldest
// (listBackupsNewestFirst()) and only falls to defaultData once every
// candidate has failed to read, not after the first one.
//
// This suite talks to the real getDb()/database module, not a mock --
// gives each scenario its own throwaway dataDir via PANEL_PATHS_CONFIG_PATH
// (mirrors linuxDataDirModeGate.test.js's pattern) so scenarios never share
// state, and vi.resetModules() so the module-level `db` singleton and
// paths.js's cached currentPaths are both genuinely fresh per scenario --
// otherwise every scenario after the first would silently no-op against an
// already-initialized db from a previous one.

const originalConfigPathEnv = process.env.PANEL_PATHS_CONFIG_PATH;
const tempRoots = [];

afterEach(() => {
  if (originalConfigPathEnv === undefined) {
    delete process.env.PANEL_PATHS_CONFIG_PATH;
  } else {
    process.env.PANEL_PATHS_CONFIG_PATH = originalConfigPathEnv;
  }
  vi.resetModules();
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function freshDbModule() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "zcp-db-recovery-"),
  );
  tempRoots.push(tempRoot);
  const dataDir = path.join(tempRoot, "data");
  const configPath = path.join(tempRoot, "paths.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ dataDir, logsDir: path.join(tempRoot, "logs") }),
  );
  process.env.PANEL_PATHS_CONFIG_PATH = configPath;
  vi.resetModules();
  // Importing the module creates dataDir/backups as a side effect, so the
  // caller can write seed files into them right after this resolves.
  const mod = await import("../database/init.js");
  return { ...mod, dataDir };
}

function writeCorruptDbJson(dataDir) {
  fs.writeFileSync(path.join(dataDir, "db.json"), "{ this is not valid json");
}

function writeBackup(dataDir, isoLikeTimestamp, content) {
  const backupPath = path.join(
    dataDir,
    "backups",
    `db-${isoLikeTimestamp}.json`,
  );
  fs.writeFileSync(backupPath, content);
  return backupPath;
}

describe("getDb() corruption recovery: falls through the whole backup ring", () => {
  it("recovers from an older backup when the newest backup is ALSO corrupt", async () => {
    const { getDb, dataDir } = await freshDbModule();

    writeCorruptDbJson(dataDir);
    // Newest by filename sort -- also corrupt, simulating the double-
    // corruption trigger (e.g. an ENOSPC hit around the same time as db.json).
    writeBackup(dataDir, "2026-09-02T00-00-00-000Z", "{ also not valid json");
    // Older, but structurally valid and distinguishable.
    writeBackup(
      dataDir,
      "2026-09-01T00-00-00-000Z",
      JSON.stringify({
        settings: {},
        servers: [{ id: "marker-older-good-backup" }],
      }),
    );

    const db = await getDb();

    expect(db.data.servers).toEqual([{ id: "marker-older-good-backup" }]);
  });

  it("still falls back to defaultData when EVERY backup in the ring is corrupt", async () => {
    const { getDb, dataDir } = await freshDbModule();

    writeCorruptDbJson(dataDir);
    writeBackup(dataDir, "2026-09-02T00-00-00-000Z", "{ also not valid json");
    writeBackup(dataDir, "2026-09-01T00-00-00-000Z", "{ still not valid json");

    const db = await getDb();

    expect(db.data.servers).toEqual([]);
    // Migrated on load, same as any fresh-default init -- not 1 (defaultData's
    // literal) any more.
    expect(db.data._schemaVersion).toBe(3);
  });

  it("still falls back to defaultData when db.json is corrupt and no backup exists at all", async () => {
    const { getDb, dataDir } = await freshDbModule();

    writeCorruptDbJson(dataDir);

    const db = await getDb();

    expect(db.data.servers).toEqual([]);
  });

  it("recovers from the single latest backup when it is valid (no regression on the common case)", async () => {
    const { getDb, dataDir } = await freshDbModule();

    writeCorruptDbJson(dataDir);
    writeBackup(
      dataDir,
      "2026-09-02T00-00-00-000Z",
      JSON.stringify({
        settings: {},
        servers: [{ id: "marker-latest-backup" }],
      }),
    );

    const db = await getDb();

    expect(db.data.servers).toEqual([{ id: "marker-latest-backup" }]);
  });
});
