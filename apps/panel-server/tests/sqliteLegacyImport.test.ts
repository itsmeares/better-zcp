import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteSnapshotStore } from "../database/sqlite/snapshotStore.ts";
import {
  importLegacyDatabase,
  prepareLegacyImport,
} from "../database/sqlite/legacyImport.ts";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sqlite-import-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("SQLite snapshot store", () => {
  it("round-trips the full JSON shape through Drizzle and node:sqlite", async () => {
    const directory = temporaryDirectory();
    const store = createSqliteSnapshotStore(path.join(directory, "db.sqlite"));
    const data = {
      servers: [{ id: "srv-1", nested: { map: [1, 2, 3] } }],
      settings: { theme: "dark" },
      customFutureField: { kept: true },
    };

    await store.write(data);
    expect(await store.read()).toEqual(data);
    store.close();
    const database = new DatabaseSync(path.join(directory, "db.sqlite"));
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "panel_state",
        "panel_records",
        "servers",
        "users",
        "roles",
        "settings",
        "scheduled_tasks",
      ]),
    );
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM servers")
        .get().count,
    ).toBe(1);
    expect(database.prepare("SELECT id FROM servers").get().id).toBe("srv-1");
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM settings")
        .get().count,
    ).toBe(1);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM panel_state WHERE key = 'main'")
        .get().count,
    ).toBe(0);
    database.close();
    expect(fs.statSync(path.join(directory, "db.sqlite")).mode & 0o777).toBe(0o600);
  });
});

describe("legacy database import", () => {
  it("removes known secrets from SQLite and writes them to the existing secret-file layout", async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, "db.json");
    const targetPath = path.join(directory, "new", "db.sqlite");
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        settings: {
          jwtSecret: "jwt-secret",
          rconPassword: "global-rcon",
          discordBotToken: "discord-token",
          steamApiKey: "steam-api-key",
          panelPort: 3001,
        },
        servers: [{ id: "srv/one", rconPassword: "server-rcon", serverName: "Main" }],
        users: [{ id: "u1", passwordHash: "still-needed-for-login" }],
        futureField: { preserved: true },
      }),
    );

    const dryRun = await importLegacyDatabase({ sourcePath, targetPath });
    expect(dryRun.applied).toBe(false);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(dryRun.omittedSecrets).toEqual(
      expect.arrayContaining([
        { field: "settings.jwtSecret", storage: "secret-file" },
        { field: "settings.steamApiKey", storage: "manual" },
        { field: "servers[0].rconPassword", storage: "secret-file" },
      ]),
    );

    const applied = await importLegacyDatabase({ sourcePath, targetPath, apply: true });
    expect(applied.applied).toBe(true);
    expect(fs.readFileSync(path.join(directory, "new", "jwt.secret"), "utf8")).toBe("jwt-secret");
    expect(fs.readFileSync(path.join(directory, "new", "rconPassword.secret"), "utf8")).toBe("global-rcon");
    expect(fs.readFileSync(path.join(directory, "new", "discordBotToken.secret"), "utf8")).toBe("discord-token");
    expect(fs.readFileSync(path.join(directory, "new", "server-secrets", "srv_one.secret"), "utf8")).toBe("server-rcon");

    const store = createSqliteSnapshotStore(targetPath);
    const imported = await store.read();
    store.close();
    expect(imported.settings).toEqual({ panelPort: 3001 });
    expect(imported.servers).toEqual([{ id: "srv/one", serverName: "Main" }]);
    expect(imported.users[0].passwordHash).toBe("still-needed-for-login");
    expect(imported.futureField).toEqual({ preserved: true });
    expect(fs.readFileSync(sourcePath, "utf8")).toContain("jwt-secret");
  });

  it("reports extra fields without deleting them", () => {
    const prepared = prepareLegacyImport({ extra: { keep: true }, settings: {} });
    expect(prepared.unknownKeys).toEqual(["extra"]);
    expect(prepared.data.extra).toEqual({ keep: true });
  });

  it("refuses to overwrite an existing target", async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, "db.json");
    const targetPath = path.join(directory, "db.sqlite");
    fs.writeFileSync(sourcePath, JSON.stringify({ settings: {} }));
    fs.writeFileSync(targetPath, "existing");

    await expect(importLegacyDatabase({ sourcePath, targetPath, apply: true })).rejects.toThrow(
      "Refusing to overwrite",
    );
  });
});
