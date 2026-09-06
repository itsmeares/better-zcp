import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";


const {
  getDb,
  getDatabaseStats,
  createDatabaseBackup,
  compactDatabase,
  logCommand,
} = await import("../database/init.js");
const { getDataPaths } = await import("../utils/paths.ts");

const { dataDir } = getDataPaths();
const backupDir = path.join(dataDir, "backups");
const dbPath = path.join(dataDir, "db.json");

describe("POST /api/debug/database/backup (createDatabaseBackup)", () => {
  it("negative control: reports failure and writes nothing when there is no database yet", () => {
    expect(fs.existsSync(dbPath)).toBe(false);
    const beforeFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];

    return createDatabaseBackup().then((result) => {
      expect(result.success).toBe(false);
      expect(result.file).toBeUndefined();
      const afterFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
      expect(afterFiles).toEqual(beforeFiles);
    });
  });

  it("checks the FILE, not the response message: a real db.json produces a real backup file with matching content", async () => {
    await getDb();
    expect(fs.existsSync(dbPath)).toBe(true);
    const beforeFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];

    const result = await createDatabaseBackup();

    expect(result.success).toBe(true);
    expect(typeof result.file).toBe("string");
    const afterFiles = fs.readdirSync(backupDir);
    expect(afterFiles.length).toBe(beforeFiles.length + 1);
    expect(afterFiles).toContain(result.file);

    const backupContent = JSON.parse(
      fs.readFileSync(path.join(backupDir, result.file), "utf8"),
    );
    const liveContent = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    expect(backupContent).toEqual(liveContent);
  });
});

describe("GET /api/debug/database (getDatabaseStats)", () => {
  it("reflects a real, freshly-seeded record count -- not a hardcoded or stale figure", async () => {
    const before = await getDatabaseStats();

    for (let i = 0; i < 7; i++) {
      await logCommand(`test-cmd-${i}`, "ok", true);
    }

    const after = await getDatabaseStats();
    expect(after.collections.command_history).toBe(
      before.collections.command_history + 7,
    );
    expect(after.totalRecords).toBe(before.totalRecords + 7);
  });
});

describe("POST /api/debug/database/compact (compactDatabase)", () => {
  it("really trims an over-cap array and persists the trim to disk, not just the returned counts", async () => {
    await getDb();
    const OVER_CAP = 510;
    const seeded = Array.from({ length: OVER_CAP }, (_, i) => ({
      id: `seed-${i}`,
      command: `cmd-${i}`,
      response: "ok",
      success: 1,
      executed_at: new Date().toISOString(),
    }));
    const liveDb = await getDb();
    liveDb.data.command_history = seeded;

    const result = await compactDatabase();

    expect(result.before).toBeGreaterThanOrEqual(OVER_CAP);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.after).toBe(result.before - result.removed);

    const persisted = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    expect(persisted.command_history.length).toBe(500);
  });
});
