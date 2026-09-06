import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

// 2026-08-27, do-the-three-database-routes-actually-work-when-called: the
// Node/Express half of the works-if-called question fengari does not reach.
// apps/panel-server/routes/debug.js's GET /database, POST /database/backup, POST
// /database/compact are trivial pass-throughs to database/init.js's
// getDatabaseStats/createDatabaseBackup/compactDatabase --
//   router.get("/database", ..., async (req, res) => {
//     const stats = await getDatabaseStats(); res.json(stats);
//   })
// and identically for the other two (see debug.js:5232-5264) -- so
// exercising the underlying functions directly exercises exactly what the
// route does. debug.js is the file this round; not edited, only read
// to confirm the pass-through shape, and only database/init.js's exported
// functions are imported/tested here.
//
// SAFETY, load-bearing: these are REAL, UNMOCKED modules -- deliberately,
// per the instruction to check STATE not just response messages, which a
// mock of database/init.js itself would make meaningless. This is safe
// ONLY because apps/panel-server/tests/vitest.perFileDataDir.setup.mjs (wired via
// vitest.config.js's setupFiles) mints a fresh, throwaway temp dataDir and
// points PANEL_PATHS_CONFIG_PATH at it BEFORE this file's module graph is
// ever imported -- database/init.js reads that env var into a module-level
// const at ITS OWN import time, so dbPath/backupDir below can never resolve
// to the operator's real data/db.json. Same convention already used by
// db-tmp-cleanup.test.js and circuitBreakerStatus.test.js for the same
// reason. Never deletes/writes anything outside this per-file temp root.

const {
  getDb,
  getDatabaseStats,
  createDatabaseBackup,
  compactDatabase,
  logCommand,
} = await import("../database/init.js");
const { getDataPaths } = await import("../utils/paths.js");

const { dataDir } = getDataPaths();
const backupDir = path.join(dataDir, "backups");
const dbPath = path.join(dataDir, "db.json");

describe("POST /api/debug/database/backup (createDatabaseBackup)", () => {
  // Ordered FIRST and deliberately: db.json does not exist yet at this
  // point in the file (nothing before this has called getDb()/logCommand()),
  // which is the real negative branch createBackup() has in its own source
  // -- `if (!fs.existsSync(dbPath)) return null`. A genuine failure, not a
  // contrived one.
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
    await getDb(); // creates dbPath for real, for the first time in this file
    expect(fs.existsSync(dbPath)).toBe(true);
    const beforeFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];

    const result = await createDatabaseBackup();

    expect(result.success).toBe(true);
    expect(typeof result.file).toBe("string");
    const afterFiles = fs.readdirSync(backupDir);
    expect(afterFiles.length).toBe(beforeFiles.length + 1);
    expect(afterFiles).toContain(result.file);

    // The exact defect this instruction named: a route that returns success
    // and writes nothing. Read the claimed file back and prove it is a real,
    // non-empty copy of the live db.json -- not just that a file with that
    // name happens to exist.
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
  // compactDatabase() has no separate ok/fail branch in its own source --
  // it always returns a {before, after, removed} object if getDb()/
  // flushWrites() don't throw, so there is no artificial-failure path to
  // negative-control the way createDatabaseBackup's missing-file branch
  // allows. The equivalent-rigor check for THIS handler, per the same
  // "check the state, not the message" instruction, is: seed an array past
  // its real retention cap, compact, and verify the RE-READ-FROM-DISK file
  // (not the in-memory object that produced the response) was actually
  // trimmed -- a stub reporting a plausible-looking removed count without
  // truly persisting the trim would fail this.
  it("really trims an over-cap array and persists the trim to disk, not just the returned counts", async () => {
    await getDb();
    const OVER_CAP = 510; // RETENTION.command_history is 500
    const seeded = Array.from({ length: OVER_CAP }, (_, i) => ({
      id: `seed-${i}`,
      command: `cmd-${i}`,
      response: "ok",
      success: 1,
      executed_at: new Date().toISOString(),
    }));
    // Direct db.data mutation (bypassing logCommand's own append-and-cap, so
    // the array genuinely starts over the retention cap for this test).
    // getDb() returns the live Low instance -- mutate its data directly.
    const liveDb = await getDb();
    liveDb.data.command_history = seeded;

    const result = await compactDatabase();

    expect(result.before).toBeGreaterThanOrEqual(OVER_CAP);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.after).toBe(result.before - result.removed);

    // Re-read from disk, independent of the in-memory object the function
    // itself returned counts from.
    const persisted = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    expect(persisted.command_history.length).toBe(500);
  });
});
