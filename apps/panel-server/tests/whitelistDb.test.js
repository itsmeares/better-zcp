import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { getWhitelistDatabasePath, listWhitelistAccounts, listServerRoleNames } from "../utils/whitelistDb.js";

let root;
const SQL_WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/sql.js/dist/sql-wasm.wasm");

async function writeFixture() {
  const SQL = await initSqlJs({
    locateFile: () => SQL_WASM_PATH,
  });
  const db = new SQL.Database();
  db.run("CREATE TABLE role (id INTEGER, name TEXT)");
  db.run("CREATE TABLE whitelist (id INTEGER, world TEXT, username TEXT, password TEXT, lastConnection TEXT, role INTEGER, authType INTEGER, steamid TEXT, ownerid TEXT, displayName TEXT)");
  db.run("CREATE TABLE allowedsteamid (steamid TEXT NOT NULL)");
  db.run("INSERT INTO role VALUES (2, 'user'), (7, 'admin')");
  db.run("INSERT INTO whitelist VALUES (1, 'DoomerZ', 'Alice', 'secret', '2026-08-13', 7, 1, '7656119', NULL, NULL)");
  db.run("INSERT INTO whitelist VALUES (2, 'OtherServer', 'Other', 'secret', NULL, 2, 1, NULL, NULL, NULL)");
  db.run("INSERT INTO allowedsteamid VALUES ('76561198000000000')");

  const dataDir = path.join(root, "db");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "DoomerZ.db"), Buffer.from(db.export()));
  db.close();
}

describe("whitelist database reader", () => {
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads only the active world and never returns passwords", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-whitelist-"));
    await writeFixture();

    expect(getWhitelistDatabasePath(root, "DoomerZ")).toBe(
      path.join(root, "db", "DoomerZ.db"),
    );
    const result = await listWhitelistAccounts(root, "DoomerZ");

    expect(result.available).toBe(true);
    expect(result.accounts).toEqual([
      expect.objectContaining({
        username: "Alice",
        role: "admin",
        steamId: "7656119",
      }),
    ]);
    expect(result.allowedSteamIds).toEqual(['76561198000000000']);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects path traversal in server names", () => {
    expect(getWhitelistDatabasePath(root, "../OtherServer")).toBeNull();
    expect(getWhitelistDatabasePath(root, "nested/server")).toBeNull();
  });
});

// 2026-08-30, release-runup: access-levels-should-come-from-the-server-not-a-
// hardcoded-array Phase 2. Same [role] table listWhitelistAccounts already
// reads (Roles.getRoles() is a live, DB-backed table per Kevin's jar audit,
// not a fixed enum) -- listServerRoleNames just returns its names instead of
// using them to resolve a whitelist row's role id.
describe("listServerRoleNames", () => {
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the server's real role names, including a custom role no static list could know about", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-roles-"));
    const SQL = await initSqlJs({
      locateFile: () => SQL_WASM_PATH,
    });
    const db = new SQL.Database();
    db.run("CREATE TABLE role (id INTEGER, name TEXT)");
    db.run("INSERT INTO role VALUES (2, 'user'), (7, 'admin'), (8, 'vip')");
    const dataDir = path.join(root, "db");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "DoomerZ.db"), Buffer.from(db.export()));
    db.close();

    const result = await listServerRoleNames(root, "DoomerZ");

    expect(result.available).toBe(true);
    expect(result.roleNames).toEqual(expect.arrayContaining(["user", "admin", "vip"]));
    // 'none' is a SetAccessLevelCommand special case, never a row in this
    // table (confirmed by the real jar and by ROLE_NAMES's own defaults) --
    // this function must not invent it, callers add it themselves.
    expect(result.roleNames).not.toContain("none");
  });

  it("reports unavailable, not a thrown error, when the server has never started (no db file yet)", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-roles-missing-"));

    const result = await listServerRoleNames(root, "NeverStartedServer");

    expect(result.available).toBe(false);
    expect(result.roleNames).toEqual([]);
    expect(typeof result.reason).toBe("string");
  });
});
