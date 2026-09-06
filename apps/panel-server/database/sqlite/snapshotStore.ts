import fs from "node:fs";
import path from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  panelRecords,
  panelState,
  roles,
  scheduledTasks,
  servers,
  settings,
  users,
} from "./schema.ts";

const LEGACY_SNAPSHOT_KEY = "main";
const NORMALIZED_COLLECTIONS = new Set([
  "servers",
  "users",
  "roles",
  "scheduled_tasks",
]);

type JsonRecord = Record<string, unknown>;

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

function toJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function fromJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error: unknown) {
    throw new Error(`SQLite ${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function nullableText(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function nullableInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function nullableBoolean(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

function normalizedId(collection: string, value: unknown, position: number): string {
  const record = asRecord(value);
  const id = record.id ?? record.steamId ?? record.player_name;
  return id === undefined ? `${collection}:${position}` : String(id);
}

function recordKey(collection: string, value: unknown, position: number): string {
  return `${collection}:${normalizedId(collection, value, position)}:${position}`;
}

function normalizedRows<T>(
  values: unknown[],
  map: (value: JsonRecord, id: string, updatedAt: number) => T,
  collection: string,
  updatedAt: number,
): T[] {
  return values.map((value, position) =>
    map(asRecord(value), normalizedId(collection, value, position), updatedAt),
  );
}

function createSchema(client: DatabaseSync): void {
  // Idempotent startup migrations keep the native install self-contained.
  client.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS panel_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS panel_records (
      key TEXT PRIMARY KEY NOT NULL,
      collection TEXT NOT NULL,
      position INTEGER NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      server_name TEXT,
      install_path TEXT,
      server_port INTEGER,
      rcon_host TEXT,
      rcon_port INTEGER,
      is_remote INTEGER,
      is_active INTEGER,
      lifecycle_provider TEXT,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT,
      role TEXT,
      role_id TEXT,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      is_seeded INTEGER,
      capabilities TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      cron_expression TEXT,
      command TEXT,
      server_id TEXT,
      enabled INTEGER,
      last_run TEXT,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function parseRowData<T extends JsonRecord>(value: string, label: string): T {
  return asRecord(fromJson(value, label)) as T;
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
    createSchema(client);
    schemaReady = true;
  };

  const database = createDrizzleDatabase(client);
  let closed = false;

  return {
    async read(): Promise<unknown> {
      ensureSchema();

      const stateRows = await database.select().from(panelState).all();
      const legacySnapshot = stateRows.find(
        (row) => row.key === LEGACY_SNAPSHOT_KEY,
      );
      if (legacySnapshot) {
        return fromJson(legacySnapshot.value, "legacy snapshot");
      }

      const data: JsonRecord = {};
      for (const row of stateRows) {
        data[row.key] = fromJson(row.value, `state key ${row.key}`);
      }

      const recordRows = await database
        .select()
        .from(panelRecords)
        .orderBy(asc(panelRecords.collection), asc(panelRecords.position))
        .all();
      for (const row of recordRows) {
        const collection = Array.isArray(data[row.collection])
          ? (data[row.collection] as unknown[])
          : (data[row.collection] = []);
        collection.push(fromJson(row.value, `record ${row.key}`));
      }

      const serverRows = await database.select().from(servers).all();
      if (serverRows.length > 0) {
        data.servers = serverRows.map((row) =>
          parseRowData(row.data, `server ${row.id}`),
        );
      }

      const userRows = await database.select().from(users).all();
      if (userRows.length > 0) {
        data.users = userRows.map((row) =>
          parseRowData(row.data, `user ${row.id}`),
        );
      }

      const roleRows = await database.select().from(roles).all();
      if (roleRows.length > 0) {
        data.roles = roleRows.map((row) =>
          parseRowData(row.data, `role ${row.id}`),
        );
      }

      const taskRows = await database.select().from(scheduledTasks).all();
      if (taskRows.length > 0) {
        data.scheduled_tasks = taskRows.map((row) =>
          parseRowData(row.data, `scheduled task ${row.id}`),
        );
      }

      const settingRows = await database.select().from(settings).all();
      if (settingRows.length > 0) {
        data.settings = Object.fromEntries(
          settingRows.map((row) => [
            row.key,
            fromJson(row.value, `setting ${row.key}`),
          ]),
        );
      }

      return Object.keys(data).length > 0 ? data : undefined;
    },

    async write(data: unknown): Promise<void> {
      ensureSchema();
      const source = asRecord(data);
      const now = Date.now();

      client.exec("BEGIN IMMEDIATE");
      try {
        await database.delete(panelState).run();
        await database.delete(panelRecords).run();
        await database.delete(servers).run();
        await database.delete(users).run();
        await database.delete(roles).run();
        await database.delete(settings).run();
        await database.delete(scheduledTasks).run();

        const stateValues = Object.entries(source)
          .filter(
            ([key, value]) =>
              !NORMALIZED_COLLECTIONS.has(key) &&
              key !== "settings" &&
              !Array.isArray(value) &&
              JSON.stringify(value) !== undefined,
          )
          .map(([key, value]) => ({
            key,
            value: toJson(value),
            updatedAt: now,
          }));
        if (stateValues.length > 0) {
          await database.insert(panelState).values(stateValues).run();
        }

        const recordValues = Object.entries(source)
          .filter(
            ([key, value]) =>
              Array.isArray(value) && !NORMALIZED_COLLECTIONS.has(key),
          )
          .flatMap(([collection, value]) =>
            (value as unknown[]).map((item, position) => ({
              key: recordKey(collection, item, position),
              collection,
              position,
              value: toJson(item),
            })),
          );
        if (recordValues.length > 0) {
          await database.insert(panelRecords).values(recordValues).run();
        }

        const serverValues = normalizedRows(
          Array.isArray(source.servers) ? source.servers : [],
          (server, id, updatedAt) => ({
            id,
            name: nullableText(server.name),
            serverName: nullableText(server.serverName),
            installPath: nullableText(server.installPath),
            serverPort: nullableInteger(server.serverPort),
            rconHost: nullableText(server.rconHost),
            rconPort: nullableInteger(server.rconPort),
            isRemote: nullableBoolean(server.isRemote),
            isActive: nullableBoolean(server.isActive),
            lifecycleProvider: nullableText(server.lifecycleProvider),
            data: toJson(server),
            updatedAt,
          }),
          "servers",
          now,
        );
        if (serverValues.length > 0) {
          await database.insert(servers).values(serverValues).run();
        }

        const userValues = normalizedRows(
          Array.isArray(source.users) ? source.users : [],
          (user, id, updatedAt) => ({
            id,
            username: nullableText(user.username),
            role: nullableText(user.role),
            roleId: nullableText(user.roleId),
            data: toJson(user),
            updatedAt,
          }),
          "users",
          now,
        );
        if (userValues.length > 0) {
          await database.insert(users).values(userValues).run();
        }

        const roleValues = normalizedRows(
          Array.isArray(source.roles) ? source.roles : [],
          (role, id, updatedAt) => ({
            id,
            name: nullableText(role.name),
            isSeeded: nullableBoolean(role.isSeeded),
            capabilities: toJson(role.capabilities ?? []),
            data: toJson(role),
            updatedAt,
          }),
          "roles",
          now,
        );
        if (roleValues.length > 0) {
          await database.insert(roles).values(roleValues).run();
        }

        const taskValues = normalizedRows(
          Array.isArray(source.scheduled_tasks) ? source.scheduled_tasks : [],
          (task, id, updatedAt) => ({
            id,
            name: nullableText(task.name),
            cronExpression: nullableText(task.cron_expression),
            command: nullableText(task.command),
            serverId: nullableText(task.server_id),
            enabled: nullableBoolean(task.enabled),
            lastRun: nullableText(task.last_run),
            data: toJson(task),
            updatedAt,
          }),
          "scheduled_tasks",
          now,
        );
        if (taskValues.length > 0) {
          await database.insert(scheduledTasks).values(taskValues).run();
        }

        const settingValues = Object.entries(asRecord(source.settings))
          .filter(([, value]) => JSON.stringify(value) !== undefined)
          .map(([key, value]) => ({
            key,
            value: toJson(value),
            updatedAt: now,
          }));
        if (settingValues.length > 0) {
          await database.insert(settings).values(settingValues).run();
        }

        client.exec("COMMIT");
      } catch (error: unknown) {
        try {
          client.exec("ROLLBACK");
        } catch {
          // Preserve the original write error.
        }
        throw error;
      }

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
