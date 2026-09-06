import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import initSqlJs from "sql.js";
import { createLogger } from "./logger.js";

const log = createLogger("WhitelistDB");
const ROLE_NAMES = new Map([
  [1, "banned"],
  [2, "user"],
  [3, "priority"],
  [4, "observer"],
  [5, "gm"],
  [6, "moderator"],
  [7, "admin"],
]);

let sqlPromise;

function locateWasm() {
  const candidates = [];
  if (process.pkg) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, "sql-wasm.wasm"));
    candidates.push(path.join(execDir, "assets", "sql-wasm.wasm"));
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, "../node_modules/sql.js/dist/sql-wasm.wasm"));
  } catch {
    // Fall through to the working-directory candidates.
  }
  candidates.push(path.resolve(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"));
  candidates.push(path.resolve(process.cwd(), "sql-wasm.wasm"));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => locateWasm() || file,
    });
  }
  return sqlPromise;
}

export function getWhitelistDatabasePath(zomboidDataPath, serverName) {
  if (
    typeof zomboidDataPath !== "string" ||
    !zomboidDataPath ||
    typeof serverName !== "string" ||
    !serverName ||
    serverName === "." ||
    serverName === ".." ||
    /[\\/\0]/.test(serverName)
  ) {
    return null;
  }
  return path.join(zomboidDataPath, "db", `${serverName}.db`);
}

function loadRoleMap(db) {
  const roles = new Map(ROLE_NAMES);
  const roleResult = db.exec("SELECT id, name FROM role");
  for (const [id, name] of roleResult[0]?.values || []) {
    if (Number.isInteger(Number(id)) && typeof name === "string") {
      roles.set(Number(id), name);
    }
  }
  return roles;
}

export async function listWhitelistAccounts(zomboidDataPath, serverName) {
  const dbPath = getWhitelistDatabasePath(zomboidDataPath, serverName);
  if (!dbPath) {
    return { available: false, accounts: [], reason: "Invalid server database path" };
  }
  if (!fs.existsSync(dbPath)) {
    return { available: false, accounts: [], reason: "Whitelist database not found" };
  }

  try {
    const SQL = await getSql();
    const db = new SQL.Database(await fs.promises.readFile(dbPath));
    try {
      const accounts = [];
      const allowedSteamIds = [];
      const roles = loadRoleMap(db);

      const statement = db.prepare(
        "SELECT id, username, lastConnection, role, authType, steamid, ownerid, displayName FROM whitelist WHERE world = ? OR world = '' OR world IS NULL ORDER BY lower(COALESCE(username, '')), id",
      );
      try {
        statement.bind([serverName]);
        while (statement.step()) {
          const row = statement.getAsObject();
          accounts.push({
            id: Number(row.id),
            username: row.username || "",
            lastConnection: row.lastConnection || null,
            role: roles.get(Number(row.role)) || `role-${Number(row.role)}`,
            authType: Number(row.authType) || 0,
            steamId: row.steamid || null,
            ownerId: row.ownerid || null,
            displayName: row.displayName || null,
          });
        }
      } finally {
        statement.free();
      }

      try {
        const allowedResult = db.exec("SELECT steamid FROM allowedsteamid ORDER BY steamid");
        for (const [steamId] of allowedResult[0]?.values || []) {
          if (typeof steamId === "string" && /^\d{17}$/.test(steamId)) {
            allowedSteamIds.push(steamId);
          }
        }
      } catch (error) {
        log.debug(`Allowed SteamID table is unavailable in ${dbPath}: ${error.message}`);
      }
      return { available: true, accounts, allowedSteamIds };
    } finally {
      db.close();
    }
  } catch (error) {
    log.warn(`Could not read whitelist database ${dbPath}: ${error.message}`);
    return { available: false, accounts: [], reason: "Whitelist database could not be read" };
  }
}

export async function listServerRoleNames(zomboidDataPath, serverName) {
  const dbPath = getWhitelistDatabasePath(zomboidDataPath, serverName);
  if (!dbPath) {
    return { available: false, roleNames: [], reason: "Invalid server database path" };
  }
  if (!fs.existsSync(dbPath)) {
    return { available: false, roleNames: [], reason: "Server database not found" };
  }

  try {
    const SQL = await getSql();
    const db = new SQL.Database(await fs.promises.readFile(dbPath));
    try {
      const roles = loadRoleMap(db);
      return { available: true, roleNames: [...roles.values()] };
    } finally {
      db.close();
    }
  } catch (error) {
    log.warn(`Could not read role table from ${dbPath}: ${error.message}`);
    return { available: false, roleNames: [], reason: "Server database could not be read" };
  }
}
