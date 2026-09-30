import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getDataPaths } from "../utils/paths.ts";
import { createLogger } from "../utils/logger.ts";
import { normalizeMemoryGb } from "../utils/memory.ts";
import { parseClampedInteger } from "../utils/queryNumbers.ts";
import {
  withRconSecret,
  withoutRconSecret,
  deleteServerSecret,
} from "../utils/serverRconSecrets.ts";
import { redactRconCommandSecrets } from "../utils/rconCommandRedaction.ts";
import { readUiSecretFile, writeUiSecretFile } from "../utils/uiSecretFile.ts";
import { currentServerId, requireServerId } from "../utils/serverScope.ts";

type AnyRecord = Record<string, any>;
export type ServerRecord = AnyRecord & {
  id: string;
  serverName?: string;
  installPath?: string;
  zomboidDataPath?: string | null;
  lifecycleProvider?: string;
  dockerContainerName?: string | null;
};
export type ScheduledTaskRecord = {
  id: number;
  server_id: string;
  name: string;
  cron_expression: string;
  command: string;
  enabled: number;
  last_run: string | null;
  created_at: string;
};
const log = createLogger("DB");
let database: DatabaseSync | undefined;
let openedPath: string | undefined;
let backupTimer: ReturnType<typeof setInterval> | undefined;
const RETENTION: Record<string, number> = {
  command_history: 500,
  player_logs: 1000,
  server_events: 500,
  schedule_history: 500,
  performance_history: 1440,
  bridge_logs: 500,
  backup_records: 500,
};
const PANEL_SETTINGS =
  /^(auth|jwt|cors|setupToken$|panelPort$|panelUpdate|preUpdate|steamApiKey$|darkMode$|enablePublicIpLookup$|lanIpAddress$|steamcmdPath$|steamUpdateAccount$)/;
const PROFILE_FIELDS: Record<string, string> = {
  serverPath: "installPath",
  serverName: "serverName",
  serverConfigPath: "serverConfigPath",
  zomboidDataPath: "zomboidDataPath",
  rconHost: "rconHost",
  rconPort: "rconPort",
  rconPassword: "rconPassword",
  minMemory: "minMemory",
  maxMemory: "maxMemory",
  serverPort: "serverPort",
};

export function getDatabaseFilePath(): string {
  return path.join(getDataPaths().dataDir, "panel.sqlite");
}

function db(): DatabaseSync {
  const filePath = getDatabaseFilePath();
  if (database && openedPath === filePath) return database;
  database?.close();
  database = undefined;
  const opened = new DatabaseSync(filePath);
  try {
    opened.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE TABLE IF NOT EXISTS admin (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE TABLE IF NOT EXISTS settings (
        server_id TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(server_id, key)
      );
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        command TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        last_run TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduled_tasks_server ON scheduled_tasks(server_id);
      CREATE TABLE IF NOT EXISTS records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        UNIQUE(collection, server_id, id)
      );
      CREATE INDEX IF NOT EXISTS records_server ON records(collection, server_id, sequence);
    `);
    const integrity = opened.prepare("PRAGMA quick_check").get();
    if (!integrity || Object.values(integrity)[0] !== "ok")
      throw new Error("Panel database integrity check failed");
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
    database = opened;
    openedPath = filePath;
    return opened;
  } catch (error) {
    opened.close();
    if (recoverDatabase(filePath, error)) return db();
    throw error;
  }
}

function recoverDatabase(file: string, error: unknown): boolean {
  const code = (error as { errcode?: number })?.errcode;
  if (
    code !== 11 &&
    code !== 26 &&
    !(
      error instanceof Error &&
      error.message === "Panel database integrity check failed"
    )
  )
    return false;
  const directory = path.join(path.dirname(file), "backups");
  if (!fs.existsSync(directory)) return false;
  for (const name of fs
    .readdirSync(directory)
    .filter((name) => /^panel-.*\.sqlite$/.test(name))
    .sort()
    .reverse()) {
    const candidate = path.join(directory, name);
    let snapshot: DatabaseSync | undefined;
    try {
      snapshot = new DatabaseSync(candidate, { readOnly: true });
      const result = snapshot.prepare("PRAGMA integrity_check").get();
      if (result?.integrity_check !== "ok") continue;
      // A valid SQLite file from another application is not a panel backup.
      for (const table of [
        "servers",
        "admin",
        "settings",
        "scheduled_tasks",
        "records",
      ])
        snapshot.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    } catch {
      continue;
    } finally {
      snapshot?.close();
    }
    const preserved = `${file}.corrupt-${randomUUID()}`;
    fs.renameSync(file, preserved);
    try {
      fs.copyFileSync(candidate, file);
    } catch (copyError) {
      fs.renameSync(preserved, file);
      throw copyError;
    }
    log.warn(
      `Restored panel database from ${name}; damaged database preserved at ${preserved}`,
    );
    return true;
  }
  return false;
}

function transaction<T>(operation: () => T): T {
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

function records(
  collection: string,
  limit = Number.MAX_SAFE_INTEGER,
  serverId = requireServerId(),
): AnyRecord[] {
  return db()
    .prepare(
      "SELECT data FROM records WHERE collection = ? AND server_id = ? ORDER BY sequence DESC LIMIT ?",
    )
    .all(collection, serverId, limit)
    .map((row) => JSON.parse(String(row.data)));
}

function readRecord(collection: string, id: string): AnyRecord | null {
  const row = db()
    .prepare(
      "SELECT data FROM records WHERE collection=? AND server_id=? AND id=?",
    )
    .get(collection, requireServerId(), id);
  return row ? JSON.parse(String(row.data)) : null;
}

function putRecord(
  collection: string,
  value: AnyRecord,
  id = String(value.id ?? randomUUID()),
): AnyRecord {
  const serverId = requireServerId();
  db()
    .prepare(
      "INSERT INTO records(collection, server_id, id, data) VALUES(?,?,?,?) ON CONFLICT(collection,server_id,id) DO UPDATE SET data=excluded.data",
    )
    .run(collection, serverId, id, JSON.stringify(value));
  return value;
}

function deleteRecord(collection: string, id: string): boolean {
  return (
    db()
      .prepare(
        "DELETE FROM records WHERE collection=? AND server_id=? AND id=?",
      )
      .run(collection, requireServerId(), id).changes > 0
  );
}

function clearRecords(collection: string): number {
  return Number(
    db()
      .prepare("DELETE FROM records WHERE collection=? AND server_id=?")
      .run(collection, requireServerId()).changes,
  );
}

function appendHistory(
  collection: string,
  entry: AnyRecord,
  id?: string,
): AnyRecord {
  return transaction(() => {
    putRecord(collection, entry, id);
    db()
      .prepare(
        "DELETE FROM records WHERE collection=? AND server_id=? AND sequence NOT IN (SELECT sequence FROM records WHERE collection=? AND server_id=? ORDER BY sequence DESC LIMIT ?)",
      )
      .run(
        collection,
        requireServerId(),
        collection,
        requireServerId(),
        RETENTION[collection],
      );
    return entry;
  });
}

function historyLimit(
  value: unknown,
  collection: string,
  fallback = 100,
): number {
  return parseClampedInteger(value, fallback, 1, RETENTION[collection]);
}

function backup(label: string): string {
  const dir = path.join(getDataPaths().dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(
    dir,
    `panel-${timestamp}-${label}-${randomUUID().slice(0, 8)}.sqlite`,
  );
  db().prepare("VACUUM INTO ?").run(file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^panel-.*\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const name of files.slice(5)) fs.unlinkSync(path.join(dir, name));
  return file;
}

export async function initDatabase(): Promise<void> {
  if (backupTimer) clearInterval(backupTimer);
  db();
  backup("startup");
  backupTimer = setInterval(() => {
    try {
      backup("auto");
    } catch (error) {
      log.error("Panel database backup failed", error);
    }
  }, 6 * 3600000);
  backupTimer.unref();
}

export function closeDatabase(): void {
  if (backupTimer) clearInterval(backupTimer);
  backupTimer = undefined;
  database?.close();
  database = undefined;
  openedPath = undefined;
}

export async function createDatabaseBackup() {
  return { success: true, file: path.basename(backup("manual")) };
}

export async function getDatabaseStats() {
  db();
  const fileSize = fs.statSync(getDatabaseFilePath()).size;
  const collections = Object.fromEntries(
    db()
      .prepare(
        "SELECT collection, count(*) AS count FROM records GROUP BY collection",
      )
      .all()
      .map((row) => [String(row.collection), Number(row.count)]),
  );
  collections.servers = Number(
    db().prepare("SELECT count(*) AS count FROM servers").get()!.count,
  );
  collections.scheduled_tasks = Number(
    db().prepare("SELECT count(*) AS count FROM scheduled_tasks").get()!.count,
  );
  const dir = path.join(getDataPaths().dataDir, "backups");
  return {
    fileSizeBytes: fileSize,
    fileSizeKB: Math.round(fileSize / 102.4) / 10,
    backupCount: fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => /^panel-.*\.sqlite$/.test(name))
          .length
      : 0,
    collections,
    totalRecords: Object.values(collections).reduce(
      (sum, value) => sum + value,
      0,
    ),
    settingsCount: Number(
      db().prepare("SELECT count(*) AS count FROM settings").get()!.count,
    ),
  };
}

export async function compactDatabase() {
  const before = await getDatabaseStats();
  transaction(() => {
    db()
      .prepare(
        "DELETE FROM records WHERE collection='performance_history' AND json_extract(data,'$.timestamp') < ?",
      )
      .run(new Date(Date.now() - 24 * 3600000).toISOString());
  });
  db().exec("VACUUM");
  const after = await getDatabaseStats();
  return {
    before: before.totalRecords,
    after: after.totalRecords,
    removed: before.totalRecords - after.totalRecords,
  };
}

export async function getAdmin(): Promise<AnyRecord | null> {
  const row = db().prepare("SELECT data FROM admin WHERE singleton=1").get();
  return row ? JSON.parse(String(row.data)) : null;
}

export async function createAdmin(user: AnyRecord): Promise<void> {
  db()
    .prepare("INSERT INTO admin(singleton,data) VALUES(1,?)")
    .run(JSON.stringify(user));
}

export async function saveAdmin(user: AnyRecord): Promise<void> {
  const result = db()
    .prepare(
      "UPDATE admin SET data=? WHERE singleton=1 AND json_extract(data,'$.id')=?",
    )
    .run(JSON.stringify(user), user.id);
  if (result.changes !== 1) throw new Error("Admin account no longer exists");
}

export async function getSetting(key: string): Promise<any> {
  if (key === "steamApiKey") return readUiSecretFile(key);
  const serverId = currentServerId();
  if (PROFILE_FIELDS[key])
    return (await getServer(requireServerId()))?.[PROFILE_FIELDS[key]] ?? null;
  const scope = PANEL_SETTINGS.test(key) ? "" : (serverId ?? "");
  const row = db()
    .prepare("SELECT value FROM settings WHERE server_id=? AND key=?")
    .get(scope, key);
  return row ? JSON.parse(String(row.value)) : null;
}

export async function setSetting(key: string, value: any): Promise<void> {
  await setSettings([[key, value]]);
}

export async function setSettings(
  entries: Array<[string, any]>,
): Promise<void> {
  const scope = currentServerId();
  const profileUpdates = Object.fromEntries(
    entries
      .filter(([key]) => PROFILE_FIELDS[key])
      .map(([key, value]) => [PROFILE_FIELDS[key], value]),
  );
  const profile = Object.keys(profileUpdates).length
    ? readServer(requireServerId())
    : null;
  if (
    (scope || Object.keys(profileUpdates).length) &&
    !readServer(scope ?? requireServerId())
  )
    throw new Error("Server no longer exists");
  const values = entries
    .filter(([key]) => !PROFILE_FIELDS[key] && key !== "steamApiKey")
    .map(([key, value]) => [
      PANEL_SETTINGS.test(key) ? "" : (scope ?? ""),
      key,
      JSON.stringify(value ?? null),
    ]);
  if (profile) JSON.stringify({ ...profile, ...profileUpdates });
  const oldSteamKey = entries.some(([key]) => key === "steamApiKey")
    ? readUiSecretFile("steamApiKey")
    : undefined;
  try {
    transaction(() => {
      if (profile)
        persistServer({
          ...profile,
          ...profileUpdates,
          updatedAt: new Date().toISOString(),
        });
      const statement = db().prepare(
        "INSERT INTO settings(server_id,key,value) VALUES(?,?,?) ON CONFLICT(server_id,key) DO UPDATE SET value=excluded.value",
      );
      for (const [serverId, key, value] of values)
        statement.run(serverId, key, value);
      for (const [key, value] of entries)
        if (key === "steamApiKey") writeUiSecretFile(key, value);
    });
  } catch (error) {
    try {
      if (profile && Object.hasOwn(profileUpdates, "rconPassword"))
        withoutRconSecret(profile);
      if (oldSteamKey !== undefined)
        writeUiSecretFile("steamApiKey", oldSteamKey);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Settings save failed and credentials could not be restored",
      );
    }
    throw error;
  }
}

export async function getAllSettings(): Promise<AnyRecord> {
  const serverId = currentServerId();
  const settings = Object.fromEntries(
    db()
      .prepare(
        "SELECT key,value FROM settings WHERE server_id='' OR server_id=? ORDER BY server_id",
      )
      .all(serverId ?? "")
      .map((row) => [String(row.key), JSON.parse(String(row.value))]),
  );
  settings.steamApiKey = readUiSecretFile("steamApiKey");
  if (serverId) {
    const server = await getServer(serverId);
    for (const [key, field] of Object.entries(PROFILE_FIELDS))
      settings[key] = server?.[field] ?? null;
  }
  return settings;
}

export function normalizeServerMemory(server: null): null;
export function normalizeServerMemory(server: ServerRecord): ServerRecord;
export function normalizeServerMemory(server: AnyRecord): AnyRecord;
export function normalizeServerMemory(
  server: AnyRecord | null,
): AnyRecord | null {
  if (!server) return server;
  const installPath = server.installPath || process.env.PZ_SERVER_PATH || "";
  const zomboidDataPath =
    server.zomboidDataPath || process.env.PZ_SAVE_PATH || null;

  const normalized: AnyRecord = {
    ...server,
    installPath,
    zomboidDataPath,
    lifecycleProvider: ["systemd", "openrc"].includes(server.lifecycleProvider)
      ? server.lifecycleProvider
      : "direct",
    minMemory: normalizeMemoryGb(server.minMemory, 4),
    maxMemory: normalizeMemoryGb(server.maxMemory, 8),
  };
  if (
    process.env.PANEL_DOCKER_INSTALL_KIND === "split" &&
    installPath === "/pz-server" &&
    zomboidDataPath === "/zomboid" &&
    !server.dockerContainerName &&
    !server.dockerContainerId &&
    /^[A-Za-z0-9_-]+$/.test(String(server.id))
  ) {
    normalized.dockerContainerName = `zomboid-game-${server.id}`;
    if (
      !server.rconHost ||
      ["127.0.0.1", "localhost"].includes(server.rconHost)
    ) {
      normalized.rconHost = normalized.dockerContainerName;
    }
  }
  delete normalized.isRemote;
  delete normalized.remoteConfigConfigured;
  return normalized;
}

export async function getServers(): Promise<ServerRecord[]> {
  return db()
    .prepare("SELECT data FROM servers ORDER BY rowid")
    .all()
    .map((row) =>
      normalizeServerMemory(
        withRconSecret(JSON.parse(String(row.data))) as ServerRecord,
      ),
    );
}

function readServer(id: string | number): ServerRecord | null {
  const row = db()
    .prepare("SELECT data FROM servers WHERE id=?")
    .get(String(id));
  if (!row) return null;
  const server = withRconSecret(JSON.parse(String(row.data))) as ServerRecord;
  return normalizeServerMemory(server);
}

export async function getServer(
  id: string | number,
): Promise<ServerRecord | null> {
  return readServer(id);
}

export async function getCurrentServer(): Promise<ServerRecord | null> {
  const id = currentServerId();
  return id ? getServer(id) : null;
}

function persistServer(server: ServerRecord): ServerRecord {
  server = normalizeServerMemory(server);
  JSON.stringify(server);
  const data = withoutRconSecret(server);
  db()
    .prepare(
      "INSERT INTO servers(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    )
    .run(String(server.id), JSON.stringify(data));
  return normalizeServerMemory(server);
}

export async function createServer(config: AnyRecord): Promise<ServerRecord> {
  const server = {
    id: randomUUID(),
    name: config.name || config.serverName,
    serverName: config.serverName,
    installPath: config.installPath || "",
    zomboidDataPath: config.zomboidDataPath || null,
    serverConfigPath: config.serverConfigPath || null,
    dockerContainerName: config.dockerContainerName || null,
    branch: config.branch || "stable",
    rconHost: config.rconHost || "127.0.0.1",
    rconPort: config.rconPort || 27015,
    rconPassword: config.rconPassword || "",
    serverPort: config.serverPort || 16261,
    minMemory: normalizeMemoryGb(config.minMemory, 4),
    maxMemory: normalizeMemoryGb(config.maxMemory, 8),
    useNoSteam: config.useNoSteam || false,
    useDebug: config.useDebug || false,
    useUpnp: config.useUpnp !== false,
    lifecycleProvider: "direct",
    startCommand: config.startCommand || "",
    adminPassword: config.adminPassword || "",
    createdAt: new Date().toISOString(),
  };
  return persistServer(server);
}

export async function updateServer(
  id: string | number,
  updates: AnyRecord,
): Promise<ServerRecord | null> {
  const current = readServer(id);
  if (!current) return null;
  return persistServer({
    ...current,
    ...updates,
    id: current.id,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteServer(id: string | number): Promise<boolean> {
  const deleted = transaction(() => {
    const result = db()
      .prepare("DELETE FROM servers WHERE id=?")
      .run(String(id));
    if (!result.changes) return false;
    db().prepare("DELETE FROM settings WHERE server_id=?").run(String(id));
    db().prepare("DELETE FROM records WHERE server_id=?").run(String(id));
    return true;
  });
  if (deleted) deleteServerSecret(id);
  return deleted;
}

export async function logCommand(command: any, response: any, success = true) {
  const text = redactRconCommandSecrets(response);
  return appendHistory("command_history", {
    id: randomUUID(),
    command: redactRconCommandSecrets(command),
    response: typeof text === "string" ? text.slice(0, 4096) : text,
    success: success ? 1 : 0,
    executed_at: new Date().toISOString(),
  });
}
export async function getCommandHistory(limit: unknown = 100) {
  return records("command_history", historyLimit(limit, "command_history"));
}
export async function logBridgeCommand(
  action: string,
  args: AnyRecord,
  result: any,
  success = true,
  durationMs = 0,
) {
  const text = JSON.stringify(result);
  return appendHistory("bridge_logs", {
    id: randomUUID(),
    action,
    args: args || {},
    result: text?.length > 4096 ? { truncated: true } : result,
    success: success ? 1 : 0,
    duration_ms: durationMs,
    executed_at: new Date().toISOString(),
  });
}
export async function getBridgeLogs(limit: unknown = 100) {
  return records("bridge_logs", historyLimit(limit, "bridge_logs"));
}
export async function logPlayerAction(
  playerName: string,
  action: string,
  details: any = null,
) {
  return appendHistory("player_logs", {
    id: randomUUID(),
    player_name: playerName,
    action,
    details,
    logged_at: new Date().toISOString(),
  });
}
export async function getPlayerLogs(
  playerName: string | null = null,
  limit: unknown = 100,
) {
  return records("player_logs", RETENTION.player_logs)
    .filter((row) => !playerName || row.player_name === playerName)
    .slice(0, historyLimit(limit, "player_logs"));
}
export async function logServerEvent(eventType: string, message: any = null) {
  return appendHistory("server_events", {
    id: randomUUID(),
    event_type: eventType,
    message,
    created_at: new Date().toISOString(),
  });
}
export async function getServerEvents(limit: unknown = 100) {
  return records("server_events", historyLimit(limit, "server_events"));
}

export async function getScheduledTasks(): Promise<ScheduledTaskRecord[]> {
  const id = currentServerId();
  return id
    ? (db()
        .prepare("SELECT * FROM scheduled_tasks WHERE server_id=? ORDER BY id")
        .all(id) as unknown as ScheduledTaskRecord[])
    : (db()
        .prepare("SELECT * FROM scheduled_tasks ORDER BY id")
        .all() as unknown as ScheduledTaskRecord[]);
}
export async function createScheduledTask(
  name: string,
  cronExpression: string,
  command: string,
  serverId = requireServerId(),
) {
  if (String(serverId) !== requireServerId())
    throw new Error("Scheduled task belongs to another server");
  const now = new Date().toISOString();
  const result = db()
    .prepare(
      "INSERT INTO scheduled_tasks(server_id,name,cron_expression,command,created_at) VALUES(?,?,?,?,?)",
    )
    .run(requireServerId(), name, cronExpression, command, now);
  return db()
    .prepare("SELECT * FROM scheduled_tasks WHERE id=?")
    .get(result.lastInsertRowid)! as unknown as ScheduledTaskRecord;
}
export async function updateScheduledTask(
  id: any,
  name: string | undefined,
  cronExpression: string | undefined,
  command: string | undefined,
  enabled: boolean | number | undefined,
  serverId: any,
) {
  const task = db()
    .prepare("SELECT * FROM scheduled_tasks WHERE id=? AND server_id=?")
    .get(id, requireServerId());
  if (!task) return null;
  db()
    .prepare(
      "UPDATE scheduled_tasks SET name=?,cron_expression=?,command=?,enabled=?,server_id=? WHERE id=? AND server_id=?",
    )
    .run(
      name ?? task.name,
      cronExpression ?? task.cron_expression,
      command ?? task.command,
      enabled === undefined ? task.enabled : enabled ? 1 : 0,
      String(serverId ?? task.server_id),
      id,
      requireServerId(),
    );
  return db()
    .prepare("SELECT * FROM scheduled_tasks WHERE id=?")
    .get(id)! as unknown as ScheduledTaskRecord;
}
export async function deleteScheduledTask(id: any) {
  return (
    db()
      .prepare("DELETE FROM scheduled_tasks WHERE id=? AND server_id=?")
      .run(id, requireServerId()).changes > 0
  );
}
export async function updateTaskLastRun(id: any) {
  db()
    .prepare("UPDATE scheduled_tasks SET last_run=? WHERE id=? AND server_id=?")
    .run(new Date().toISOString(), id, requireServerId());
}
export async function logScheduleExecution(
  taskId: any,
  taskName: string,
  command: string,
  success: boolean,
  message: any = null,
  duration: number | null = null,
) {
  return appendHistory("schedule_history", {
    id: randomUUID(),
    task_id: taskId,
    task_name: taskName,
    command,
    success: success ? 1 : 0,
    message,
    duration,
    executed_at: new Date().toISOString(),
  });
}
export async function getScheduleHistory(
  limit: unknown = 100,
  taskId: any = null,
) {
  return records("schedule_history", RETENTION.schedule_history)
    .filter((row) => taskId === null || row.task_id === taskId)
    .slice(0, historyLimit(limit, "schedule_history"));
}
export async function clearScheduleHistory() {
  clearRecords("schedule_history");
}
export async function getLatestScheduleExecutionByCommand(command: string) {
  return (
    records("schedule_history", RETENTION.schedule_history).find(
      (row) => row.command === command,
    ) ?? null
  );
}

function findMod(collection: string, workshopId: string) {
  return readRecord(collection, workshopId);
}
function saveMod(collection: string, row: AnyRecord) {
  return putRecord(collection, row, String(row.workshop_id));
}
export async function getTrackedMods() {
  return records("tracked_mods");
}
export async function addTrackedMod(
  workshopId: string,
  name: string | null = null,
) {
  const current = findMod("tracked_mods", workshopId);
  return saveMod(
    "tracked_mods",
    current
      ? { ...current, name: name || current.name }
      : {
          id: randomUUID(),
          workshop_id: workshopId,
          name,
          server_id: requireServerId(),
          last_updated: null,
          last_checked: null,
          update_available: 0,
          preview_url: null,
          created_at: new Date().toISOString(),
        },
  );
}
export async function setModPreviewUrl(
  workshopId: string,
  previewUrl: string | null,
) {
  const row = findMod("tracked_mods", workshopId);
  if (row) saveMod("tracked_mods", { ...row, preview_url: previewUrl });
}
export async function updateModTimestamp(workshopId: string, lastUpdated: any) {
  const row = findMod("tracked_mods", workshopId);
  if (row)
    saveMod("tracked_mods", {
      ...row,
      last_updated: lastUpdated,
      last_checked: new Date().toISOString(),
    });
}
export async function setModUpdateAvailable(
  workshopId: string,
  available: boolean,
) {
  const row = findMod("tracked_mods", workshopId);
  if (row)
    saveMod("tracked_mods", { ...row, update_available: available ? 1 : 0 });
}
export async function markModsChecked(
  checkedIds: Set<any>,
  updatesById: Map<any, any> = new Map(),
) {
  transaction(() => {
    for (const row of records("tracked_mods"))
      if (checkedIds.has(row.workshop_id))
        saveMod("tracked_mods", {
          ...row,
          last_checked: new Date().toISOString(),
          update_available: updatesById.get(row.workshop_id) ? 1 : 0,
        });
  });
}
export async function removeTrackedMod(workshopId: string) {
  return deleteRecord("tracked_mods", workshopId);
}
export async function clearModUpdates() {
  transaction(() => {
    for (const row of records("tracked_mods"))
      saveMod("tracked_mods", { ...row, update_available: 0 });
  });
}
export async function getIgnoredMods() {
  return records("ignored_mods");
}
export async function addIgnoredMod(
  workshopId: string,
  name: string | null = null,
) {
  return (
    findMod("ignored_mods", workshopId) ??
    saveMod("ignored_mods", {
      workshop_id: workshopId,
      name,
      server_id: requireServerId(),
      ignored_at: new Date().toISOString(),
    })
  );
}
export async function removeIgnoredMod(workshopId: string) {
  return deleteRecord("ignored_mods", workshopId);
}
export async function clearAllIgnoredMods() {
  return clearRecords("ignored_mods");
}
export async function isModIgnored(workshopId: string) {
  return Boolean(findMod("ignored_mods", workshopId));
}
function pairKey(a: any, b: any): string | null {
  const pair = [String(a ?? "").trim(), String(b ?? "").trim()].sort();
  return pair[0] && pair[1] && pair[0] !== pair[1]
    ? JSON.stringify(pair)
    : null;
}
export async function getIgnoredModPairs() {
  return records("ignored_mod_pairs");
}
export async function addIgnoredModPair(
  a: any,
  b: any,
  reason: string | null = null,
) {
  const id = pairKey(a, b);
  if (!id) return null;
  const pair = JSON.parse(id);
  return (
    readRecord("ignored_mod_pairs", id) ??
    putRecord(
      "ignored_mod_pairs",
      {
        mod_a: pair[0],
        mod_b: pair[1],
        reason,
        server_id: requireServerId(),
        ignored_at: new Date().toISOString(),
      },
      id,
    )
  );
}
export async function removeIgnoredModPair(a: any, b: any) {
  const id = pairKey(a, b);
  return id ? deleteRecord("ignored_mod_pairs", id) : false;
}

export async function getPlayerNotes() {
  return records("player_notes");
}
export async function getPlayerNote(name: string) {
  return readRecord("player_notes", name.toLowerCase()) ?? null;
}
export async function upsertPlayerNote(
  name: string,
  note: string,
  tags: any[] = [],
) {
  return putRecord(
    "player_notes",
    {
      id: randomUUID(),
      player_name: name,
      note: note || "",
      tags,
      updated_at: new Date().toISOString(),
    },
    name.toLowerCase(),
  );
}
export async function deletePlayerNote(name: string) {
  return deleteRecord("player_notes", name.toLowerCase());
}
export async function getPlayerStats() {
  return records("player_stats");
}
export async function getPlayerStat(name: string) {
  return readRecord("player_stats", name.toLowerCase()) ?? null;
}
export async function recordPlayerSession(name: string, action: string) {
  const now = new Date().toISOString();
  const player = readRecord("player_stats", name.toLowerCase()) ?? {
    id: randomUUID(),
    player_name: name,
    total_playtime_seconds: 0,
    session_count: 0,
    first_seen: now,
    sessions: [],
  };
  player.last_seen = now;
  if (action === "connect") {
    player.last_session_start = now;
    player.session_count++;
  } else if (action === "disconnect" && player.last_session_start) {
    const duration = Math.max(
      0,
      Math.floor((Date.now() - Date.parse(player.last_session_start)) / 1000),
    );
    player.total_playtime_seconds += duration;
    player.sessions.unshift({
      start: player.last_session_start,
      end: now,
      duration_seconds: duration,
    });
    player.last_session_start = null;
  }
  player.sessions = player.sessions.filter(
    (session: AnyRecord) =>
      Date.parse(session.end) >= Date.now() - 30 * 24 * 3600000,
  );
  return putRecord("player_stats", player, name.toLowerCase());
}
export function recentPerformanceHistory(
  entries: AnyRecord[],
  now = Date.now(),
) {
  return entries
    .filter((row) => {
      const time = Date.parse(row.timestamp);
      return time >= now - 24 * 3600000 && time <= now;
    })
    .slice(-1440);
}
export async function recordPerformanceSnapshot(snapshot: AnyRecord) {
  const entry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...snapshot,
  };
  appendHistory("performance_history", entry);
  db()
    .prepare(
      "DELETE FROM records WHERE collection='performance_history' AND server_id=? AND json_extract(data,'$.timestamp') < ?",
    )
    .run(requireServerId(), new Date(Date.now() - 24 * 3600000).toISOString());
  return entry;
}
export async function getPerformanceHistory(limit: unknown = 60) {
  return recentPerformanceHistory(
    records("performance_history", 1440).reverse(),
  ).slice(-historyLimit(limit, "performance_history", 60));
}
export async function clearPerformanceHistory() {
  clearRecords("performance_history");
}
export async function getSteamIdBans() {
  return records("steamid_bans");
}
export async function addSteamIdBan(
  steamId: string,
  reason: string | null = null,
) {
  putRecord(
    "steamid_bans",
    { steamId, reason, banned_at: new Date().toISOString() },
    steamId,
  );
}
export async function removeSteamIdBan(steamId: string) {
  return deleteRecord("steamid_bans", steamId);
}

export function getDatabaseHealth(): { ok: boolean; error: string | null } {
  try {
    const result = db().prepare("PRAGMA quick_check").get();
    if (!result || Object.values(result)[0] !== "ok")
      throw new Error("Panel database integrity check failed");
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function exportDatabase(file: string): void {
  db().prepare("VACUUM INTO ?").run(file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

export async function saveBackupRecord(record: AnyRecord): Promise<void> {
  appendHistory("backup_records", record, record.fileName);
}
export async function readBackupRecords(limit = 500): Promise<AnyRecord[]> {
  return records("backup_records", limit);
}
export async function deleteBackupRecord(fileName: string): Promise<void> {
  deleteRecord("backup_records", fileName);
}
