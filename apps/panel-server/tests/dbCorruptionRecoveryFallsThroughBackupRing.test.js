import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


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
    writeBackup(dataDir, "2026-09-02T00-00-00-000Z", "{ also not valid json");
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
