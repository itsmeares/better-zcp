import fs from "node:fs";
import path from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { panelState } from "./schema.ts";

const SNAPSHOT_KEY = "main";

function rowsAsArrays(
  statement: StatementSync,
  params: SQLInputValue[],
): unknown[][] {
  return statement.all(...params).map((row) => Object.values(row));
}

function createDrizzleDatabase(client: DatabaseSync) {
  // Drizzle's sqlite-proxy driver lets us keep Node's built-in SQLite driver,
  // so the native executable does not need another native addon.
  return drizzle(async (query, params, method) => {
    const statement = client.prepare(query);
    if (method === "run") {
      statement.run(...params);
      return { rows: [] };
    }

    const rows = rowsAsArrays(statement, params);
    return { rows: method === "get" ? rows[0] : rows };
  });
}

function ensureParentDirectory(filePath: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows and some mounted filesystems do not support POSIX modes.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SqliteSnapshotStore {
  read: () => Promise<unknown>;
  write: (data: unknown) => Promise<void>;
  close: () => void;
  filePath: string;
}

export function createSqliteSnapshotStore(
  filePath: string,
): SqliteSnapshotStore {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("SQLite database path is required");
  }

  const resolvedPath = path.resolve(filePath);
  ensureParentDirectory(resolvedPath);
  const client = new DatabaseSync(resolvedPath);
  let schemaReady = false;
  const ensureSchema = (): void => {
    if (schemaReady) return;
    client.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS panel_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    schemaReady = true;
  };

  const database = createDrizzleDatabase(client);
  let closed = false;

  return {
    async read(): Promise<unknown> {
      ensureSchema();
      const row = await database
        .select()
        .from(panelState)
        .where(eq(panelState.key, SNAPSHOT_KEY))
        .get();
      if (!row) return undefined;

      try {
        return JSON.parse(row.value);
      } catch (error: unknown) {
        throw new Error(
          `SQLite snapshot is not valid JSON: ${errorMessage(error)}`,
        );
      }
    },

    async write(data: unknown): Promise<void> {
      ensureSchema();
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

    close(): void {
      if (closed) return;
      closed = true;
      client.close();
    },

    filePath: resolvedPath,
  };
}
