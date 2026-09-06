import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { panelState } from "./schema.js";

const SNAPSHOT_KEY = "main";

function rowsAsArrays(statement, params) {
  return statement.all(...params).map((row) => Object.values(row));
}

function createDrizzleDatabase(client) {
  // Drizzle's sqlite-proxy driver lets us keep Node's built-in SQLite driver,
  // so the native executable does not need another native addon.
  return drizzle(async (query, params, method) => {
    const statement = client.prepare(query);
    if (method === "run") {
      statement.run(...params);
      return { rows: [] };
    }

    const rows = rowsAsArrays(statement, params);
    return { rows: method === "get" ? rows[0] || [] : rows };
  });
}

function ensureParentDirectory(filePath) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows and some mounted filesystems do not support POSIX modes.
  }
}

export function createSqliteSnapshotStore(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("SQLite database path is required");
  }

  const resolvedPath = path.resolve(filePath);
  ensureParentDirectory(resolvedPath);
  const client = new DatabaseSync(resolvedPath);
  client.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS panel_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const database = createDrizzleDatabase(client);
  let closed = false;

  return {
    async read() {
      const row = await database
        .select()
        .from(panelState)
        .where(eq(panelState.key, SNAPSHOT_KEY))
        .get();
      if (!row) return undefined;

      try {
        return JSON.parse(row.value);
      } catch (error) {
        throw new Error(`SQLite snapshot is not valid JSON: ${error.message}`);
      }
    },

    async write(data) {
      const value = JSON.stringify(data);
      await database
        .insert(panelState)
        .values({ key: SNAPSHOT_KEY, value, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: panelState.key,
          set: { value, updatedAt: Date.now() },
        })
        .run();
      try {
        fs.chmodSync(resolvedPath, 0o600);
      } catch {
        // Windows and some mounted filesystems do not support POSIX modes.
      }
    },

    close() {
      if (closed) return;
      closed = true;
      client.close();
    },

    filePath: resolvedPath,
  };
}
