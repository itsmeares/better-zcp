import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

const { getDataPaths } = await import("../utils/paths.js");
const { dataDir, dbPath } = getDataPaths();
const backupDir = path.join(dataDir, "backups");

describe("db.json backup -> restore round trip: real code paths, not hand-crafted files", () => {
  it("FINDING (fixed 2026-09-05): createDatabaseBackup() used to snapshot a STALE on-disk db.json, silently missing a change made moments earlier", async () => {
    const { getDb, setSetting, createDatabaseBackup } = await import(
      "../database/init.js"
    );
    await getDb();

    await setSetting("roundTripMarker", "the-just-made-change");

    const result = await createDatabaseBackup();
    expect(result.success).toBe(true);

    const backupContent = JSON.parse(
      fs.readFileSync(path.join(backupDir, result.file), "utf-8"),
    );
    expect(backupContent.settings.roundTripMarker).toBe(
      "the-just-made-change",
    );
  });

  it("a real backup, taken via the real createDatabaseBackup(), survives db.json corruption and getDb() recovers it with every field intact -- diffed against the original, not spot-checked", async () => {
    const {
      getDb,
      createDatabaseBackup,
      createServer,
      insertRole,
      setSetting,
      addTrackedMod,
    } = await import("../database/init.js");
    await getDb();

    await createServer({
      serverName: "round-trip-server",
      serverConfigPath: "/fake/path",
      rconPassword: "round-trip-fake-rcon-password",
    });
    await insertRole({
      id: "role-custom-round-trip",
      name: "round-trip-custom",
      capabilities: ["players.view"],
      isSeeded: false,
    });
    await setSetting("roundTripMarker", "original-value");
    await addTrackedMod("123456", "Round Trip Mod");

    const result = await createDatabaseBackup();
    expect(result.success).toBe(true);
    const backupFile = result.file;

    const dbBeforeCorruption = await getDb();
    const originalData = JSON.parse(JSON.stringify(dbBeforeCorruption.data));

    fs.writeFileSync(dbPath, "{ not valid json, simulating corruption");

    vi.resetModules();
    const freshMod = await import("../database/init.js");
    const recoveredDb = await freshMod.getDb();

    expect(recoveredDb.data.servers).toEqual(originalData.servers);
    expect(recoveredDb.data.roles).toEqual(originalData.roles);
    expect(recoveredDb.data.settings).toEqual(originalData.settings);
    expect(recoveredDb.data.tracked_mods).toEqual(originalData.tracked_mods);
    expect(recoveredDb.data._schemaVersion).toBe(originalData._schemaVersion);

    const backedUpContent = JSON.parse(
      fs.readFileSync(path.join(backupDir, backupFile), "utf-8"),
    );
    const { rconPassword: _omitted, ...originalServerSansSecret } =
      originalData.servers[0];
    expect(backedUpContent.servers).toEqual([originalServerSansSecret]);
    expect(backedUpContent.servers[0].rconPassword).toBeUndefined();
  });

  it("schema evolution: restoring a genuinely v1-shaped backup migrates it correctly, with no silent data loss on the custom role/user it already had", async () => {
    const v1Snapshot = {
      _schemaVersion: 1,
      settings: { customOldSetting: "still-here-after-migration" },
      servers: [{ id: "srv-old", serverName: "pre-v2-server" }],
      users: [{ username: "old-admin", role: "custom-pre-split-role" }],
      roles: [
        {
          id: "role-custom-pre-split",
          name: "custom-pre-split-role",
          capabilities: ["backups.manage", "server.control"],
          isSeeded: false,
        },
      ],
    };
    fs.mkdirSync(backupDir, { recursive: true });
    for (const f of fs.readdirSync(backupDir)) {
      fs.unlinkSync(path.join(backupDir, f));
    }
    fs.writeFileSync(
      path.join(backupDir, "db-2020-01-01T00-00-00-000Z-manual.json"),
      JSON.stringify(v1Snapshot),
    );
    fs.writeFileSync(dbPath, "{ corrupt, forcing recovery from the v1 backup");

    vi.resetModules();
    const freshMod = await import("../database/init.js");
    const db = await freshMod.getDb();

    expect(db.data._schemaVersion).toBe(3);

    expect(db.data.settings.customOldSetting).toBe(
      "still-here-after-migration",
    );
    expect(db.data.servers).toEqual([
      { id: "srv-old", serverName: "pre-v2-server" },
    ]);

    const customRole = db.data.roles.find(
      (r) => r.id === "role-custom-pre-split",
    );
    expect(customRole.capabilities).toEqual(
      expect.arrayContaining(["backups.manage", "backups.download", "server.control"]),
    );

    expect(db.data.roles.some((r) => r.id === "role-admin")).toBe(true);

    const user = db.data.users.find((u) => u.username === "old-admin");
    expect(user.role).toBe("custom-pre-split-role");
    expect(user.roleId).toBe("role-custom-pre-split");
  });

  it("rotation boundary: pruning after MAX_BACKUPS+3 real backups keeps exactly the newest 5, by content -- not just by count", async () => {
    const { getDb, createDatabaseBackup, setSetting } = await import(
      "../database/init.js"
    );
    await getDb();

    const totalBackups = 8;
    for (let i = 0; i < totalBackups; i++) {
      await setSetting("rotationMarker", `backup-number-${i}`);
      const result = await createDatabaseBackup();
      expect(result.success).toBe(true);
    }

    const manualBackups = fs
      .readdirSync(backupDir)
      .filter((f) => /-manual(-\d+)?\.json$/.test(f))
      .sort();
    expect(manualBackups).toHaveLength(5);

    const survivingMarkers = manualBackups
      .map((f) =>
        JSON.parse(fs.readFileSync(path.join(backupDir, f), "utf-8")).settings
          .rotationMarker,
      )
      .sort();
    expect(survivingMarkers).toEqual([
      "backup-number-3",
      "backup-number-4",
      "backup-number-5",
      "backup-number-6",
      "backup-number-7",
    ]);
  });

  it("partial/interrupted write: a backup truncated mid-write is detected as unreadable, never restored as valid", async () => {
    const { getDb, createDatabaseBackup, setSetting } = await import(
      "../database/init.js"
    );
    await getDb();

    await setSetting("truncationMarker", "good-backup-before-truncation");
    const goodResult = await createDatabaseBackup();
    const goodPath = path.join(backupDir, goodResult.file);
    const goodContent = fs.readFileSync(goodPath, "utf-8");

    const offsets = [
      1, // barely started
      Math.floor(goodContent.length / 3),
      Math.floor(goodContent.length / 2),
      goodContent.length - 5, // nearly complete
    ];

    for (const offset of offsets) {
      const truncated = goodContent.slice(0, offset);
      let parsedOk = true;
      try {
        JSON.parse(truncated);
      } catch {
        parsedOk = false;
      }
      expect(parsedOk).toBe(false);
    }

    const truncatedBackupPath = path.join(
      backupDir,
      "db-9999-99-99T99-99-99-999Z-manual.json",
    );
    fs.writeFileSync(
      truncatedBackupPath,
      goodContent.slice(0, Math.floor(goodContent.length / 2)),
    );
    fs.writeFileSync(dbPath, "{ also corrupt, forcing ring recovery");

    vi.resetModules();
    const freshMod = await import("../database/init.js");
    const recovered = await freshMod.getDb();
    expect(recovered.data.settings.truncationMarker).toBe(
      "good-backup-before-truncation",
    );
  });
});
