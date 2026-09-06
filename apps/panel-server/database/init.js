import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { getDataPaths } from "../utils/paths.ts";
import { checkAndExitIfOwnershipBlocked } from "../utils/firstRunOwnershipCheck.ts";
import { createLogger } from "../utils/logger.ts";
import { normalizeMemoryGb } from "../utils/memory.ts";
import { parseClampedInteger } from "../utils/queryNumbers.ts";
import {
  rehydrateRconSecrets,
  redactRconSecretsForWrite,
  deleteServerSecret,
} from "../utils/serverRconSecrets.ts";
import { redactRconCommandSecrets } from "../utils/rconCommandRedaction.ts";
import { readUiSecretFile, writeUiSecretFile } from "../utils/uiSecretFile.ts";
import { isPidAlive } from "../utils/pidLiveness.ts";
const log = createLogger("DB");


export function rehydratePanelBridgeSftpPassword(data, log) {
  if (!data.settings) data.settings = {};
  if (!data.settings.panelBridgeSftpPassword) {
    const fromFile = readUiSecretFile("panelBridgeSftpPassword", log);
    if (fromFile) data.settings.panelBridgeSftpPassword = fromFile;
  }
  return data;
}

export function redactPanelBridgeSftpPasswordForWrite(data) {
  if (!data.settings?.panelBridgeSftpPassword) return data;
  writeUiSecretFile("panelBridgeSftpPassword", data.settings.panelBridgeSftpPassword);
  const { panelBridgeSftpPassword: _panelBridgeSftpPassword, ...restSettings } =
    data.settings;
  return { ...data, settings: restSettings };
}


const RETENTION = {
  command_history: 500,
  player_logs: 1000,
  server_events: 500,
  schedule_history: 500,
  performance_history: 1440,
  player_sessions: 50, // per player
  bridge_logs: 500,
};

const WRITE_DEBOUNCE_MS = 500;
const BACKUP_INTERVAL_MS = 6 * 3600000;
const MAX_BACKUPS = 5;


const paths = getDataPaths();
const dataDir = paths.dataDir;
const databaseDriver = process.env.PANEL_DATABASE_DRIVER ?? "sqlite";
const useSqliteDatabase = databaseDriver === "sqlite";
const legacyDbPath = paths.dbPath;
const dbPath = useSqliteDatabase
  ? path.join(dataDir, "db.sqlite")
  : legacyDbPath;
const dbFileExtension = useSqliteDatabase ? ".sqlite" : ".json";
const backupDir = path.join(dataDir, "backups");

export function getDatabaseFilePath() {
  return dbPath;
}

for (const dir of [dataDir, backupDir]) {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      if (
        (err.code === "EACCES" || err.code === "EPERM") &&
        checkAndExitIfOwnershipBlocked([dataDir, backupDir])
      ) {
        throw err;
      }
      throw err;
    }
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch (_) {
    /* best-effort: Windows / network shares */
  }
}


const defaultData = {
  command_history: [],
  scheduled_tasks: [],
  schedule_history: [],
  player_logs: [],
  server_events: [],
  tracked_mods: [],
  ignored_mods: [],
  ignored_mod_pairs: [],
  servers: [],
  player_notes: [],
  player_stats: [],
  mod_presets: [],
  user_templates: [],
  steamid_bans: [],
  performance_history: [],
  bridge_logs: [],
  discord_webhooks: [],
  users: [],
  roles: [],
  settings: {},
  _schemaVersion: 1,
};


const CURRENT_SCHEMA_VERSION = 3;

const MIGRATION_V2_TECHNICIAN_CAPABILITIES = [
  "backups.manage",
  "backups.download",
  "server.control",
  "server.install",
  "server.configure",
  "server.world_events",
  "rcon.execute",
  "servers.manage",
  "templates.manage",
  "bridge.setup",
  "bridge.diagnostics",
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "mods.manage",
  "automation.manage",
  "integrations.manage",
  "docker.manage",
  "chunks.manage",
  "serverfiles.manage",
];
const MIGRATION_V2_MODERATOR_CAPABILITIES = [
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "server.world_events",
];
const MIGRATION_V2_ADMIN_CAPABILITIES = [
  "users.manage",
  "roles.manage",
  "backups.manage",
  "backups.download",
  "backups.restore",
  "server.control",
  "server.install",
  "server.configure",
  "server.wipe",
  "server.world_events",
  "rcon.execute",
  "servers.manage",
  "servers.discover",
  "templates.manage",
  "bridge.setup",
  "bridge.diagnostics",
  "bridge.command",
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "players.endanger_or_impersonate",
  "mods.manage",
  "automation.manage",
  "integrations.manage",
  "docker.manage",
  "chunks.manage",
  "serverfiles.manage",
  "diagnostics.manage",
  "panel.settings",
];

export function runMigrations(data) {
  const version = data._schemaVersion || 0;
  if (version >= CURRENT_SCHEMA_VERSION) return data;

  log.info(`Running DB migrations: v${version} → v${CURRENT_SCHEMA_VERSION}`);


  if (version < 2) {
    if (!data.roles) data.roles = [];

    const seedRole = (id, name, capabilities) => {
      if (data.roles.some((r) => r.id === id)) return;
      data.roles.push({
        id,
        name,
        capabilities: [...capabilities],
        isSeeded: true,
        createdAt: new Date().toISOString(),
      });
    };
    seedRole("role-admin", "admin", MIGRATION_V2_ADMIN_CAPABILITIES);
    seedRole("role-technician", "technician", MIGRATION_V2_TECHNICIAN_CAPABILITIES);
    seedRole("role-moderator", "moderator", MIGRATION_V2_MODERATOR_CAPABILITIES);

    const roleIdByName = Object.fromEntries(data.roles.map((r) => [r.name, r.id]));
    for (const user of data.users || []) {
      if (!user.roleId && roleIdByName[user.role]) {
        user.roleId = roleIdByName[user.role];
      }
    }
  }

  if (version < 3) {
    for (const role of data.roles || []) {
      if (
        Array.isArray(role.capabilities) &&
        role.capabilities.includes("backups.manage") &&
        !role.capabilities.includes("backups.download")
      ) {
        role.capabilities.push("backups.download");
      }
    }
  }

  data._schemaVersion = CURRENT_SCHEMA_VERSION;
  log.info(`DB migrated to schema v${CURRENT_SCHEMA_VERSION}`);
  return data;
}


let db = null;
let _writeTimer = null;
let _writePromise = null;
let _dirty = false;
let _writeRetries = 0;
const MAX_WRITE_RETRIES = 5;
const WRITE_BACKOFF_BASE_MS = 1000;
const WRITE_BACKOFF_MAX_MS = 16_000;
let _writeCircuitOpenUntil = 0;
const CIRCUIT_OPEN_MS = 60_000;
let _lastWriteError = null;
let _circuitFailCount = 0;
let _backupTimer = null;
let _shutdownRegistered = false;
let _shutdownPromise = null;
let createSqliteSnapshotStore;

async function createSqliteAdapter() {
  createSqliteSnapshotStore ??= (
    await import("./sqlite/snapshotStore.ts")
  ).createSqliteSnapshotStore;
  const store = createSqliteSnapshotStore(dbPath);
  return {
    read: () => store.read(),
    write: (data) =>
      store.write(
        redactPanelBridgeSftpPasswordForWrite(redactRconSecretsForWrite(data)),
      ),
    close: () => store.close(),
  };
}

function scheduleWrite() {
  _dirty = true;

  if (Date.now() < _writeCircuitOpenUntil) return;

  if (_writeTimer) return;

  const delay =
    _writeRetries > 0
      ? Math.min(
          WRITE_BACKOFF_BASE_MS * Math.pow(2, _writeRetries - 1),
          WRITE_BACKOFF_MAX_MS,
        )
      : WRITE_DEBOUNCE_MS;

  _writeTimer = setTimeout(async () => {
    _writeTimer = null;
    await flushWrites();
  }, delay);
}

export async function flushWrites() {
  if (!_dirty || !db) return;
  _dirty = false;

  if (_writePromise) {
    try {
      await _writePromise;
    } catch {
      /* swallow */
    }
  }

  let tmpPath;
  let tmpWriteSucceeded = false;
  _writePromise = (async () => {
    try {
      if (useSqliteDatabase) {
        await db.write();
        _writeRetries = 0;
        _lastWriteError = null;
        _circuitFailCount = 0;
        log.debug(
          `DB flushed (SQLite, ${Math.round(JSON.stringify(db.data).length / 1024)}KB)`,
        );
        return;
      }

      tmpPath = `${dbPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      const data = JSON.stringify(
        redactPanelBridgeSftpPasswordForWrite(redactRconSecretsForWrite(db.data)),
        null,
        2,
      );
      fs.writeFileSync(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
      tmpWriteSucceeded = true;
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch (_) {
        /* best-effort: Windows */
      }
      fs.renameSync(tmpPath, dbPath);
      _writeRetries = 0;
      _lastWriteError = null;
      _circuitFailCount = 0;
      log.debug(`DB flushed (${Math.round(data.length / 1024)}KB)`);
    } catch (err) {
      if (tmpWriteSucceeded) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best-effort -- may not exist, may be locked by the same contention that failed the rename */
        }
      }
      _writeRetries++;
      _lastWriteError = err.message;
      if (_writeRetries >= MAX_WRITE_RETRIES) {
        log.error(
          `DB write failed ${_writeRetries} times, opening circuit breaker for ${CIRCUIT_OPEN_MS / 1000}s: ${err.message}`,
        );
        _circuitFailCount = _writeRetries;
        _writeCircuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
        _writeRetries = 0;
        _dirty = true;
      } else {
        log.error(
          `Write error (attempt ${_writeRetries}/${MAX_WRITE_RETRIES}): ${err.message}`,
        );
        _dirty = true;
        if (!_writeTimer) {
          const delay = Math.min(
            WRITE_BACKOFF_BASE_MS * Math.pow(2, _writeRetries - 1),
            WRITE_BACKOFF_MAX_MS,
          );
          _writeTimer = setTimeout(async () => {
            _writeTimer = null;
            await flushWrites();
          }, delay);
        }
      }
    }
  })();

  await _writePromise;
  _writePromise = null;
}

export function getCircuitBreakerStatus() {
  const open = Date.now() < _writeCircuitOpenUntil;
  return {
    open,
    lastError: _lastWriteError,
    failCount: open ? _circuitFailCount : _writeRetries,
    cooldownEndsAt: open
      ? new Date(_writeCircuitOpenUntil).toISOString()
      : null,
  };
}

export async function commitNow() {
  _dirty = true;
  await flushWrites();
}

export function closeDatabase() {
  if (useSqliteDatabase && db) db.adapter.close();
}


const TMP_FILE_RE = /^db\.json\.(\d+)\.[0-9a-z]+\.tmp$/i;

const MIN_ORPHAN_AGE_MS = 60_000;

export function sweepOrphanedTmpFiles() {
  let entries;
  try {
    entries = fs.readdirSync(dataDir);
  } catch (err) {
    log.debug(`Tmp sweep: could not read ${dataDir}: ${err.message}`);
    return;
  }

  for (const name of entries) {
    const match = TMP_FILE_RE.exec(name);
    if (!match) continue;

    const pid = parseInt(match[1], 10);
    if (isPidAlive(pid)) continue;

    const filePath = path.join(dataDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs < MIN_ORPHAN_AGE_MS) continue;
      fs.unlinkSync(filePath);
      log.warn(`Removed orphaned tmp file from dead pid ${pid}: ${name}`);
    } catch (err) {
      log.debug(`Tmp sweep: could not inspect/remove ${name}: ${err.message}`);
    }
  }
}


function createBackup(label = "") {
  try {
    if (!fs.existsSync(dbPath)) return null;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = label ? `-${label}` : "";
    let backupFile = path.join(
      backupDir,
      `db-${timestamp}${suffix}${dbFileExtension}`,
    );
    for (let collision = 2; fs.existsSync(backupFile); collision++) {
      backupFile = path.join(
        backupDir,
        `db-${timestamp}${suffix}-${collision}${dbFileExtension}`,
      );
    }

    fs.copyFileSync(dbPath, backupFile);
    try {
      fs.chmodSync(backupFile, 0o600);
    } catch (_) {
      /* best-effort: Windows */
    }
    pruneBackups();
    return backupFile;
  } catch (err) {
    log.error(`Backup failed: ${err.message}`);
    return null;
  }
}

const BACKUP_COLLISION_SUFFIX_RE = /^(.*)-(\d+)$/;

function sortBackupFilenamesNewestFirst(filenames) {
  return filenames
    .map((name) => {
      const withoutExt = name.slice(0, -dbFileExtension.length);
      const match = withoutExt.match(BACKUP_COLLISION_SUFFIX_RE);
      return match
        ? { name, key: match[1], suffix: parseInt(match[2], 10) }
        : { name, key: withoutExt, suffix: 1 };
    })
    .sort((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? 1 : -1;
      return b.suffix - a.suffix;
    })
    .map((c) => c.name);
}

function pruneBackups() {
  try {
    const files = sortBackupFilenamesNewestFirst(
      fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith("db-") && f.endsWith(dbFileExtension)),
    );

    for (const file of files.slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(backupDir, file));
    }
  } catch (err) {
    log.debug(`Backup pruning error: ${err.message}`);
  }
}

function listBackupsNewestFirst() {
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("db-") && f.endsWith(dbFileExtension));
    return sortBackupFilenamesNewestFirst(files).map((f) =>
      path.join(backupDir, f),
    );
  } catch {
    log.debug(`No backups found to list`);
    return [];
  }
}

function startBackupSchedule() {
  if (_backupTimer) clearInterval(_backupTimer);
  _backupTimer = setInterval(async () => {
    await flushWrites();
    createBackup("auto");
  }, BACKUP_INTERVAL_MS);
  if (_backupTimer.unref) _backupTimer.unref();
}


const SHUTDOWN_FLUSH_MAX_ATTEMPTS = 3;
const SHUTDOWN_FLUSH_RETRY_DELAY_MS = 200;

export async function flushForShutdown() {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  for (let attempt = 1; attempt <= SHUTDOWN_FLUSH_MAX_ATTEMPTS; attempt++) {
    await flushWrites();
    if (!_dirty) return true;
    if (attempt < SHUTDOWN_FLUSH_MAX_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, SHUTDOWN_FLUSH_RETRY_DELAY_MS),
      );
    }
  }
  return !_dirty;
}

function registerShutdownHandlers() {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;

  const shutdown = (signal) => {
    if (_shutdownPromise) {
      if (signal === "beforeExit" && useSqliteDatabase && db) {
        return _shutdownPromise.then(() => db?.adapter.close());
      }
      return _shutdownPromise;
    }

    _shutdownPromise = (async () => {
      log.info(`${signal} received — flushing writes...`);
      if (_backupTimer) {
        clearInterval(_backupTimer);
        _backupTimer = null;
      }
      await flushForShutdown();
      createBackup("shutdown");
      // The main application's shutdown path closes SQLite after all of its
      // own async cleanup has finished. Closing here would race that flush.
      if (signal === "beforeExit" && useSqliteDatabase && db) {
        db.adapter.close();
      }
    })();
    return _shutdownPromise;
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("beforeExit", () => shutdown("beforeExit"));
}


function validateData(data) {
  const repaired = { ...defaultData };
  const replacedKeys = [];

  for (const [key, defaultValue] of Object.entries(defaultData)) {
    if (Array.isArray(defaultValue)) {
      if (Array.isArray(data?.[key])) {
        repaired[key] = data[key];
      } else {
        repaired[key] = defaultValue;
        if (data?.[key] !== undefined) replacedKeys.push(key);
      }
    } else if (typeof defaultValue === "object" && defaultValue !== null) {
      if (
        typeof data?.[key] === "object" &&
        !Array.isArray(data?.[key]) &&
        data?.[key] !== null
      ) {
        repaired[key] = data[key];
      } else {
        repaired[key] = defaultValue;
        if (data?.[key] !== undefined) replacedKeys.push(key);
      }
    } else {
      repaired[key] = data?.[key] ?? defaultValue;
    }
  }

  if (replacedKeys.length > 0) {
    log.error(
      `DB validation found wrong-typed collection(s) and replaced them with empty defaults, discarding their contents: ${replacedKeys.join(", ")}`,
    );
    try {
      const snapshotPath = path.join(
        backupDir,
        `pre-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
      fs.writeFileSync(snapshotPath, JSON.stringify(data, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      log.warn(
        `Saved a snapshot of the pre-repair file for recovery: ${snapshotPath}`,
      );
    } catch (snapErr) {
      log.error(`Could not snapshot pre-repair data: ${snapErr.message}`);
    }
  }

  return repaired;
}

function appendCapped(arr, item, max, { newest = true } = {}) {
  if (newest) {
    arr.unshift(item);
    if (arr.length > max) arr.length = max;
  } else {
    arr.push(item);
    if (arr.length > max) arr.splice(0, arr.length - max);
  }
  return arr;
}

function compactData(data) {
  const trimArray = (arr, max) => {
    if (Array.isArray(arr) && arr.length > max) return arr.slice(0, max);
    return arr;
  };
  const trimArrayEnd = (arr, max) => {
    if (Array.isArray(arr) && arr.length > max) return arr.slice(-max);
    return arr;
  };

  data.command_history = trimArray(
    data.command_history,
    RETENTION.command_history,
  );
  data.player_logs = trimArray(data.player_logs, RETENTION.player_logs);
  data.server_events = trimArray(data.server_events, RETENTION.server_events);
  data.schedule_history = trimArray(
    data.schedule_history,
    RETENTION.schedule_history,
  );
  data.bridge_logs = trimArray(data.bridge_logs || [], RETENTION.bridge_logs);
  data.performance_history = trimArrayEnd(
    data.performance_history,
    RETENTION.performance_history,
  );

  if (Array.isArray(data.player_stats)) {
    for (const stat of data.player_stats) {
      if (
        Array.isArray(stat.sessions) &&
        stat.sessions.length > RETENTION.player_sessions
      ) {
        stat.sessions = stat.sessions.slice(0, RETENTION.player_sessions);
      }
    }
  }

  return data;
}

export async function getDb() {
  if (!db) {
    if (
      useSqliteDatabase &&
      !fs.existsSync(dbPath) &&
      fs.existsSync(legacyDbPath)
    ) {
      throw new Error(
        `SQLite driver is enabled but ${path.basename(dbPath)} is missing while ${path.basename(legacyDbPath)} exists. Run the explicit legacy importer before starting with PANEL_DATABASE_DRIVER=sqlite.`,
      );
    }

    sweepOrphanedTmpFiles();

    if (fs.existsSync(dbPath)) {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch (_) {
        /* best-effort: Windows */
      }
    }
    try {
      for (const f of fs.readdirSync(backupDir)) {
        if (f.startsWith("db-") && f.endsWith(dbFileExtension)) {
          try {
            fs.chmodSync(path.join(backupDir, f), 0o600);
          } catch (_) {
            /* ignore */
          }
        }
      }
    } catch (_) {
      /* backupDir may not be readable yet on first run */
    }

    const adapter = useSqliteDatabase
      ? await createSqliteAdapter()
      : new JSONFile(dbPath);
    db = new Low(adapter, defaultData);

    let loadedCleanly = false;
    try {
      await db.read();
      loadedCleanly = true;
    } catch (err) {
      log.error(`Failed to read database: ${err.message}`);

      if (useSqliteDatabase) {
        db.adapter.close();
      }

      if (err.code === "EACCES" || err.code === "EPERM") {
        checkAndExitIfOwnershipBlocked([dataDir, dbPath, backupDir]);
        // Falls through only if checkAndExitIfOwnershipBlocked() found
        // every one of those paths genuinely readable/writable by THIS
        // process (fs.accessSync agrees) -- so db.read()'s EACCES/EPERM
        // came from something access() itself can't see (a permissions
        // change mid-flight between the check and the read, an exotic
        // mandatory-access-control layer, an immutable file attribute).
        // The existing corruption-recovery path below is still the right
        // fallback for that case.
      }

      const backups = listBackupsNewestFirst();
      if (backups.length > 0) {
        try {
          const corruptPath = path.join(
            backupDir,
            `corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}${dbFileExtension}`,
          );
          fs.copyFileSync(dbPath, corruptPath);
          try {
            fs.chmodSync(corruptPath, 0o600);
          } catch (_) {
            /* best-effort */
          }
        } catch (_) {
          /* best-effort */
        }

        let recovered = false;
        for (const backup of backups) {
          log.warn(`Attempting recovery from ${path.basename(backup)}...`);
          try {
            fs.copyFileSync(backup, dbPath);
            if (useSqliteDatabase) {
              db.adapter = await createSqliteAdapter();
            }
            await db.read();
            log.info(
              `Database recovery successful from ${path.basename(backup)}!`,
            );
            recovered = true;
            break;
          } catch (recoverErr) {
            if (useSqliteDatabase) {
              db.adapter.close();
            }
            log.error(
              `Recovery from ${path.basename(backup)} failed: ${recoverErr.message}`,
            );
          }
        }
        if (!recovered) {
          if (useSqliteDatabase) {
            throw new Error(
              "SQLite database recovery failed; refusing to replace it with a fresh database.",
            );
          }
          log.error("All backups failed to recover — starting fresh");
          db.data = { ...defaultData };
        }
      } else {
        if (useSqliteDatabase) {
          throw new Error(
            "SQLite database could not be read and has no backup; refusing to start with an empty database.",
          );
        }
        log.warn("No backup found, starting with fresh database.");
        db.data = { ...defaultData };
      }
    }

    db.data = validateData(db.data);
    db.data = runMigrations(db.data);
    db.data = compactData(db.data);
    db.data = rehydrateRconSecrets(db.data, log);
    db.data = rehydratePanelBridgeSftpPassword(db.data, log);

    _dirty = true;
    await flushWrites();

    if (loadedCleanly && fs.existsSync(dbPath)) {
      createBackup("startup");
    }

    startBackupSchedule();
    registerShutdownHandlers();

    const stats = getDatabaseStatsSync();
    log.info(
      `Loaded — ${stats.totalRecords} records, ${stats.fileSizeKB}KB, ${stats.backupCount} backups`,
    );
  }
  return db;
}

export async function initDatabase() {
  await getDb();
  return db;
}


function getDatabaseStatsSync() {
  const data = db?.data || defaultData;
  let fileSize = 0;
  try {
    fileSize = fs.statSync(dbPath).size;
  } catch (e) {
    log.debug(`DB file stat failed (may not exist yet): ${e.message}`);
  }

  let backupCount = 0;
  try {
    backupCount = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("db-") && f.endsWith(dbFileExtension)).length;
  } catch (e) {
    log.debug(`Backup dir read failed: ${e.message}`);
  }

  return {
    fileSizeBytes: fileSize,
    fileSizeKB: Math.round((fileSize / 1024) * 10) / 10,
    backupCount,
    collections: {
      command_history: data.command_history?.length ?? 0,
      scheduled_tasks: data.scheduled_tasks?.length ?? 0,
      schedule_history: data.schedule_history?.length ?? 0,
      player_logs: data.player_logs?.length ?? 0,
      server_events: data.server_events?.length ?? 0,
      tracked_mods: data.tracked_mods?.length ?? 0,
      servers: data.servers?.length ?? 0,
      player_notes: data.player_notes?.length ?? 0,
      player_stats: data.player_stats?.length ?? 0,
      mod_presets: data.mod_presets?.length ?? 0,
      user_templates: data.user_templates?.length ?? 0,
      performance_history: data.performance_history?.length ?? 0,
      bridge_logs: data.bridge_logs?.length ?? 0,
      discord_webhooks: data.discord_webhooks?.length ?? 0,
    },
    totalRecords: Object.values(data).reduce(
      (sum, v) => sum + (Array.isArray(v) ? v.length : 0),
      0,
    ),
    settingsCount: Object.keys(data.settings || {}).length,
  };
}

export async function getDatabaseStats() {
  await getDb();
  return getDatabaseStatsSync();
}

export async function createDatabaseBackup() {
  await flushWrites();
  const file = createBackup("manual");
  return file
    ? { success: true, file: path.basename(file) }
    : { success: false };
}

export async function compactDatabase() {
  const db = await getDb();
  const before = getDatabaseStatsSync();
  db.data = compactData(db.data);
  scheduleWrite();
  await flushWrites();
  const after = getDatabaseStatsSync();
  return {
    before: before.totalRecords,
    after: after.totalRecords,
    removed: before.totalRecords - after.totalRecords,
  };
}


function generateId() {
  return randomUUID();
}

function generateNumericId(collection) {
  const maxExisting = Array.isArray(collection)
    ? collection.reduce(
        (max, item) => Math.max(max, typeof item.id === "number" ? item.id : 0),
        0,
      )
    : 0;
  return Math.max(maxExisting + 1, Date.now());
}


export async function logCommand(command, response, success = true) {
  const db = await getDb();
  const redactedCommand = redactRconCommandSecrets(command);
  const redactedResponse = redactRconCommandSecrets(response);
  const truncatedResponse =
    redactedResponse && redactedResponse.length > 4096
      ? redactedResponse.substring(0, 4096) + "... [truncated]"
      : redactedResponse;

  const entry = {
    id: generateId(),
    command: redactedCommand,
    response: truncatedResponse,
    success: success ? 1 : 0,
    executed_at: new Date().toISOString(),
  };

  appendCapped(db.data.command_history, entry, RETENTION.command_history);
  scheduleWrite();
  return entry;
}

export async function getCommandHistory(limit = 100) {
  const db = await getDb();
  const safeLimit = parseClampedInteger(limit, 100, 1, RETENTION.command_history);
  return db.data.command_history.slice(0, safeLimit);
}


export async function logBridgeCommand(
  action,
  args,
  result,
  success = true,
  durationMs = 0,
) {
  const db = await getDb();
  if (!db.data.bridge_logs) db.data.bridge_logs = [];

  const truncatedResult = (() => {
    try {
      const s = JSON.stringify(result);
      return s && s.length > 4096
        ? JSON.parse(s.substring(0, 4096) + '..."}}')
        : result;
    } catch {
      return { truncated: true };
    }
  })();

  const entry = {
    id: generateId(),
    action,
    args: args || {},
    result: truncatedResult,
    success: success ? 1 : 0,
    duration_ms: durationMs,
    executed_at: new Date().toISOString(),
  };

  appendCapped(db.data.bridge_logs, entry, RETENTION.bridge_logs);
  scheduleWrite();
  return entry;
}

export async function getBridgeLogs(limit = 100) {
  const db = await getDb();
  if (!db.data.bridge_logs) return [];
  const safeLimit = parseClampedInteger(limit, 100, 1, RETENTION.bridge_logs);
  return db.data.bridge_logs.slice(0, safeLimit);
}


export async function getScheduledTasks() {
  const db = await getDb();
  const tasks = db.data.scheduled_tasks || [];

  const activeServerId = await getActiveServerId();
  if (activeServerId) {
    let migrated = false;
    for (const task of tasks) {
      if (!task.server_id) {
        task.server_id = activeServerId;
        migrated = true;
      }
    }
    if (migrated) scheduleWrite();
  }

  return tasks;
}

export async function createScheduledTask(
  name,
  cronExpression,
  command,
  serverId = null,
) {
  const db = await getDb();
  if (!Array.isArray(db.data.scheduled_tasks)) db.data.scheduled_tasks = [];

  const resolvedServerId = serverId || (await getActiveServerId());

  const task = {
    id: generateNumericId(db.data.scheduled_tasks),
    name,
    cron_expression: cronExpression,
    command,
    server_id: resolvedServerId,
    enabled: 1,
    last_run: null,
    created_at: new Date().toISOString(),
  };

  db.data.scheduled_tasks.push(task);
  scheduleWrite();
  return task;
}

export async function updateScheduledTask(
  id,
  name,
  cronExpression,
  command,
  enabled,
  serverId,
) {
  const db = await getDb();
  const index = db.data.scheduled_tasks.findIndex((t) => t.id === id);
  if (index === -1) return null;

  const task = db.data.scheduled_tasks[index];
  if (name !== undefined) task.name = name;
  if (cronExpression !== undefined) task.cron_expression = cronExpression;
  if (command !== undefined) task.command = command;
  if (enabled !== undefined) task.enabled = enabled ? 1 : 0;
  if (serverId !== undefined) task.server_id = serverId;
  scheduleWrite();
  return task;
}

export async function deleteScheduledTask(id) {
  const db = await getDb();
  const index = db.data.scheduled_tasks.findIndex((t) => t.id === id);
  if (index === -1) return false;

  db.data.scheduled_tasks.splice(index, 1);
  scheduleWrite();
  return true;
}

export async function updateTaskLastRun(id) {
  const db = await getDb();
  const task = db.data.scheduled_tasks.find((t) => t.id === id);
  if (task) {
    task.last_run = new Date().toISOString();
    scheduleWrite();
  }
}


export async function logScheduleExecution(
  taskId,
  taskName,
  command,
  success,
  message = null,
  duration = null,
) {
  const db = await getDb();
  if (!db.data.schedule_history) db.data.schedule_history = [];

  const entry = {
    id: generateId(),
    task_id: taskId,
    task_name: taskName,
    command,
    success: success ? 1 : 0,
    message,
    duration,
    executed_at: new Date().toISOString(),
  };

  appendCapped(db.data.schedule_history, entry, RETENTION.schedule_history);
  scheduleWrite();
  return entry;
}

export async function getScheduleHistory(limit = 100, taskId = null) {
  const db = await getDb();
  if (!db.data.schedule_history) return [];

  let history = db.data.schedule_history;
  if (taskId !== null) {
    history = history.filter((h) => h.task_id === taskId);
  }
  const safeLimit = parseClampedInteger(limit, 100, 1, RETENTION.schedule_history);
  return history.slice(0, safeLimit);
}

export async function clearScheduleHistory() {
  const db = await getDb();
  db.data.schedule_history = [];
  scheduleWrite();
}

export async function getLatestScheduleExecutionByCommand(command) {
  const db = await getDb();
  const history = db.data.schedule_history || [];
  return history.find((h) => h.command === command) || null;
}


export async function logPlayerAction(playerName, action, details = null) {
  const db = await getDb();
  const entry = {
    id: generateId(),
    player_name: playerName,
    action,
    details,
    logged_at: new Date().toISOString(),
  };

  appendCapped(db.data.player_logs, entry, RETENTION.player_logs);
  scheduleWrite();
  return entry;
}

export async function getPlayerLogs(playerName = null, limit = 100) {
  const db = await getDb();
  let logs = db.data.player_logs;
  if (playerName) {
    logs = logs.filter((l) => l.player_name === playerName);
  }
  const safeLimit = parseClampedInteger(limit, 100, 1, RETENTION.player_logs);
  return logs.slice(0, safeLimit);
}


export async function logServerEvent(eventType, message = null) {
  try {
    const db = await getDb();
    const entry = {
      id: generateId(),
      event_type: eventType,
      message,
      created_at: new Date().toISOString(),
    };

    appendCapped(db.data.server_events, entry, RETENTION.server_events);
    scheduleWrite();
    return entry;
  } catch (error) {
    log.warn(`Could not record server event ${eventType}: ${error.message}`);
    return null;
  }
}


async function getActiveServerId() {
  const db = await getDb();
  const active = db.data.servers.find((s) => s.isActive) || db.data.servers[0];
  return active ? String(active.id) : null;
}

export async function getTrackedMods() {
  const db = await getDb();
  const serverId = await getActiveServerId();
  if (!serverId) return db.data.tracked_mods;
  return db.data.tracked_mods.filter((m) => m.server_id === serverId);
}

export async function addTrackedMod(workshopId, name = null) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  const existing = db.data.tracked_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (existing) {
    existing.name = name || existing.name;
    if (!existing.server_id && serverId) existing.server_id = serverId;
    scheduleWrite();
    return existing;
  }

  const mod = {
    id: generateId(),
    workshop_id: workshopId,
    name,
    server_id: serverId,
    last_updated: null,
    last_checked: null,
    update_available: 0,
    preview_url: null,
    created_at: new Date().toISOString(),
  };
  db.data.tracked_mods.push(mod);
  scheduleWrite();
  return mod;
}

export async function setModPreviewUrl(workshopId, previewUrl) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  const mod = db.data.tracked_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (mod && mod.preview_url !== previewUrl) {
    mod.preview_url = previewUrl || null;
    scheduleWrite();
  }
}

export async function updateModTimestamp(workshopId, lastUpdated) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  const mod = db.data.tracked_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (mod) {
    mod.last_updated = lastUpdated;
    mod.last_checked = new Date().toISOString();
    if (!mod.server_id && serverId) mod.server_id = serverId;
    scheduleWrite();
  }
}

export async function setModUpdateAvailable(workshopId, available) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  const mod = db.data.tracked_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (mod) {
    mod.update_available = available ? 1 : 0;
    if (!mod.server_id && serverId) mod.server_id = serverId;
    scheduleWrite();
  }
}

export async function markModsChecked(checkedIds, updatesById = new Map()) {
  if (!checkedIds || checkedIds.size === 0) return;
  const db = await getDb();
  const serverId = await getActiveServerId();
  const now = new Date().toISOString();
  let touched = 0;
  for (const mod of db.data.tracked_mods) {
    if (mod.server_id !== serverId && mod.server_id) continue;
    if (!checkedIds.has(mod.workshop_id)) continue;
    mod.last_checked = now;
    mod.update_available = updatesById.get(mod.workshop_id) ? 1 : 0;
    if (!mod.server_id && serverId) mod.server_id = serverId;
    touched++;
  }
  if (touched > 0) scheduleWrite();
}

export async function removeTrackedMod(workshopId) {
  const db = await getDb();
  const serverId = await getActiveServerId();
  const index = db.data.tracked_mods.findIndex(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (index === -1) return false;

  db.data.tracked_mods.splice(index, 1);
  scheduleWrite();
  return true;
}

export async function clearModUpdates() {
  const db = await getDb();
  const serverId = await getActiveServerId();
  db.data.tracked_mods.forEach((m) => {
    if (m.server_id === serverId || !m.server_id) {
      m.update_available = 0;
    }
  });
  scheduleWrite();
}


export async function getIgnoredMods() {
  const db = await getDb();
  if (!db.data.ignored_mods) db.data.ignored_mods = [];
  const serverId = await getActiveServerId();
  if (!serverId) return db.data.ignored_mods;
  return db.data.ignored_mods.filter(
    (m) => m.server_id === serverId || !m.server_id,
  );
}

export async function addIgnoredMod(workshopId, name = null) {
  const db = await getDb();
  if (!db.data.ignored_mods) db.data.ignored_mods = [];
  const serverId = await getActiveServerId();
  const existing = db.data.ignored_mods.find(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (existing) return existing;
  const entry = {
    workshop_id: workshopId,
    name,
    server_id: serverId,
    ignored_at: new Date().toISOString(),
  };
  db.data.ignored_mods.push(entry);
  scheduleWrite();
  return entry;
}

export async function removeIgnoredMod(workshopId) {
  const db = await getDb();
  if (!db.data.ignored_mods) db.data.ignored_mods = [];
  const serverId = await getActiveServerId();
  const index = db.data.ignored_mods.findIndex(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
  if (index === -1) return false;
  db.data.ignored_mods.splice(index, 1);
  scheduleWrite();
  return true;
}

export async function clearAllIgnoredMods() {
  const db = await getDb();
  if (!db.data.ignored_mods) db.data.ignored_mods = [];
  const serverId = await getActiveServerId();
  const before = db.data.ignored_mods.length;
  db.data.ignored_mods = db.data.ignored_mods.filter(
    (m) => m.server_id && m.server_id !== serverId,
  );
  const removed = before - db.data.ignored_mods.length;
  if (removed > 0) scheduleWrite();
  return removed;
}

export async function isModIgnored(workshopId) {
  const db = await getDb();
  if (!db.data.ignored_mods) return false;
  const serverId = await getActiveServerId();
  return db.data.ignored_mods.some(
    (m) =>
      m.workshop_id === workshopId &&
      (m.server_id === serverId || !m.server_id),
  );
}


function _normalizePair(modIdA, modIdB) {
  const a = String(modIdA || "").trim();
  const b = String(modIdB || "").trim();
  if (!a || !b || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

export async function getIgnoredModPairs() {
  const db = await getDb();
  if (!db.data.ignored_mod_pairs) db.data.ignored_mod_pairs = [];
  const serverId = await getActiveServerId();
  if (!serverId) return db.data.ignored_mod_pairs;
  return db.data.ignored_mod_pairs.filter(
    (p) => p.server_id === serverId || !p.server_id,
  );
}

export async function addIgnoredModPair(modIdA, modIdB, reason = null) {
  const pair = _normalizePair(modIdA, modIdB);
  if (!pair) return null;
  const db = await getDb();
  if (!db.data.ignored_mod_pairs) db.data.ignored_mod_pairs = [];
  const serverId = await getActiveServerId();
  const existing = db.data.ignored_mod_pairs.find(
    (p) =>
      p.mod_a === pair[0] &&
      p.mod_b === pair[1] &&
      (p.server_id === serverId || !p.server_id),
  );
  if (existing) return existing;
  const entry = {
    mod_a: pair[0],
    mod_b: pair[1],
    reason: reason || null,
    server_id: serverId,
    ignored_at: new Date().toISOString(),
  };
  db.data.ignored_mod_pairs.push(entry);
  scheduleWrite();
  return entry;
}

export async function removeIgnoredModPair(modIdA, modIdB) {
  const pair = _normalizePair(modIdA, modIdB);
  if (!pair) return false;
  const db = await getDb();
  if (!db.data.ignored_mod_pairs) db.data.ignored_mod_pairs = [];
  const serverId = await getActiveServerId();
  const before = db.data.ignored_mod_pairs.length;
  db.data.ignored_mod_pairs = db.data.ignored_mod_pairs.filter(
    (p) =>
      !(
        p.mod_a === pair[0] &&
        p.mod_b === pair[1] &&
        (p.server_id === serverId || !p.server_id)
      ),
  );
  const removed = before - db.data.ignored_mod_pairs.length;
  if (removed > 0) scheduleWrite();
  return removed > 0;
}


export async function getSetting(key) {
  const db = await getDb();
  return db.data.settings[key] ?? null;
}

export async function setSetting(key, value) {
  const db = await getDb();
  db.data.settings[key] = value;
  scheduleWrite();
}

export async function getAllSettings() {
  const db = await getDb();
  return db.data.settings;
}


export function normalizeServerMemory(server) {
  if (!server) return server;
  const installPath = server.installPath || process.env.PZ_SERVER_PATH || "";
  const zomboidDataPath =
    server.zomboidDataPath || process.env.PZ_SAVE_PATH || null;

  const pathsConfigured = Boolean(installPath || zomboidDataPath);
  const pathsExistLocally =
    Boolean(installPath && fs.existsSync(installPath)) ||
    Boolean(zomboidDataPath && fs.existsSync(zomboidDataPath));
  const hasStoredIsRemote =
    server.isRemote !== undefined && server.isRemote !== null;

  return {
    ...server,
    installPath,
    zomboidDataPath,
    isRemote: hasStoredIsRemote
      ? server.isRemote
      : pathsConfigured
        ? !pathsExistLocally
        : false,
    lifecycleProvider: ["systemd", "openrc"].includes(server.lifecycleProvider)
      ? server.lifecycleProvider
      : "direct",
    minMemory: normalizeMemoryGb(server.minMemory, 4),
    maxMemory: normalizeMemoryGb(server.maxMemory, 8),
  };
}

export async function getServers() {
  const db = await getDb();
  return (db.data.servers || []).map(normalizeServerMemory);
}

export async function getServer(id) {
  const db = await getDb();
  return normalizeServerMemory(
    db.data.servers.find((s) => String(s.id) === String(id)) || null,
  );
}

export async function getActiveServer() {
  const db = await getDb();
  return normalizeServerMemory(
    db.data.servers.find((s) => s.isActive) || db.data.servers[0] || null,
  );
}

export async function createServer(serverConfig) {
  const db = await getDb();
  if (!db.data.servers) db.data.servers = [];

  const isFirst = db.data.servers.length === 0;

  const server = {
    id: generateId(),
    name: serverConfig.name || serverConfig.serverName,
    serverName: serverConfig.serverName,
    installPath: serverConfig.installPath || "",
    zomboidDataPath: serverConfig.zomboidDataPath || null,
    serverConfigPath: serverConfig.serverConfigPath || null,
    dockerContainerName: serverConfig.dockerContainerName || null,
    branch: serverConfig.branch || "stable",
    rconHost: serverConfig.rconHost || "127.0.0.1",
    rconPort: serverConfig.rconPort || 27015,
    rconPassword: serverConfig.rconPassword || "",
    serverPort: serverConfig.serverPort || 16261,
    minMemory: normalizeMemoryGb(serverConfig.minMemory, 4),
    maxMemory: normalizeMemoryGb(serverConfig.maxMemory, 8),
    useNoSteam: serverConfig.useNoSteam || false,
    useDebug: serverConfig.useDebug || false,
    useUpnp: serverConfig.useUpnp !== false,
    isRemote: serverConfig.isRemote || false,
    lifecycleProvider: "direct",
    startCommand: serverConfig.startCommand || "",
    adminPassword: serverConfig.adminPassword || "",
    isActive: isFirst,
    createdAt: new Date().toISOString(),
  };

  db.data.servers.push(server);

  if (isFirst) {
    syncServerToSettings(db, server);
  }

  scheduleWrite();
  return normalizeServerMemory(server);
}

export async function updateServer(id, updates) {
  const db = await getDb();
  const index = db.data.servers.findIndex((s) => String(s.id) === String(id));
  if (index === -1) return null;

  db.data.servers[index] = {
    ...db.data.servers[index],
    ...updates,
    id,
    updatedAt: new Date().toISOString(),
  };
  db.data.servers[index].minMemory = normalizeMemoryGb(
    db.data.servers[index].minMemory,
    4,
  );
  db.data.servers[index].maxMemory = normalizeMemoryGb(
    db.data.servers[index].maxMemory,
    8,
  );
  scheduleWrite();
  return normalizeServerMemory(db.data.servers[index]);
}

export async function deleteServer(id) {
  const db = await getDb();
  const index = db.data.servers.findIndex((s) => String(s.id) === String(id));
  if (index === -1) return false;

  const wasActive = db.data.servers[index].isActive;
  const serverId = String(db.data.servers[index].id);
  db.data.servers.splice(index, 1);

  db.data.tracked_mods = db.data.tracked_mods.filter(
    (m) => m.server_id !== serverId,
  );

  if (wasActive && db.data.servers.length > 0) {
    db.data.servers[0].isActive = true;
  }

  deleteServerSecret(serverId);

  scheduleWrite();
  return true;
}

export async function setActiveServer(id) {
  const db = await getDb();
  const server = db.data.servers.find((s) => String(s.id) === String(id));
  if (!server) return null;

  db.data.servers.forEach((s) => {
    s.isActive = String(s.id) === String(id);
  });

  syncServerToSettings(db, server);
  scheduleWrite();
  return server;
}

function syncServerToSettings(db, server) {
  const normalizedServer = normalizeServerMemory(server);
  db.data.settings.serverPath = server.installPath;
  db.data.settings.serverName = server.serverName;
  db.data.settings.rconHost = server.rconHost;
  db.data.settings.rconPort = server.rconPort;
  db.data.settings.rconPassword = server.rconPassword;
  db.data.settings.serverPort = server.serverPort;
  db.data.settings.minMemory = normalizedServer.minMemory;
  db.data.settings.maxMemory = normalizedServer.maxMemory;
  db.data.settings.zomboidDataPath = server.zomboidDataPath;
  db.data.settings.serverConfigPath = server.serverConfigPath;
}


export async function getRoles() {
  const db = await getDb();
  return db.data.roles || [];
}

export async function getRoleById(id) {
  const db = await getDb();
  return (db.data.roles || []).find((r) => String(r.id) === String(id)) || null;
}

export async function getRoleByName(name) {
  if (!name) return null;
  const db = await getDb();
  return (db.data.roles || []).find((r) => r.name === name) || null;
}

export async function insertRole(role) {
  const db = await getDb();
  if (!db.data.roles) db.data.roles = [];
  db.data.roles.push(role);
  scheduleWrite();
  return role;
}

export async function replaceRoleById(id, updatedRole) {
  const db = await getDb();
  const roles = db.data.roles || [];
  const index = roles.findIndex((r) => String(r.id) === String(id));
  if (index === -1) return null;
  roles[index] = updatedRole;
  scheduleWrite();
  return updatedRole;
}

export async function removeRoleById(id) {
  const db = await getDb();
  const roles = db.data.roles || [];
  const index = roles.findIndex((r) => String(r.id) === String(id));
  if (index === -1) return false;
  roles.splice(index, 1);
  scheduleWrite();
  return true;
}

export async function getUsersForRole(role) {
  const db = await getDb();
  const users = db.data.users || [];
  return users.filter(
    (u) => u.roleId === role.id || (role.isSeeded && u.role === role.name),
  );
}

export async function getUsersForRoleAccounting() {
  const db = await getDb();
  return (db.data.users || []).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    roleId: u.roleId,
  }));
}

export async function reassignRoleMembers(fromRole, toRole) {
  const db = await getDb();
  let count = 0;
  for (const user of db.data.users || []) {
    const matches =
      user.roleId === fromRole.id || (fromRole.isSeeded && user.role === fromRole.name);
    if (!matches) continue;
    user.roleId = toRole.id;
    user.role = toRole.name;
    count++;
  }
  if (count > 0) scheduleWrite();
  return count;
}


export async function getPlayerNotes() {
  const db = await getDb();
  if (!db.data.player_notes) db.data.player_notes = [];
  return db.data.player_notes;
}

export async function getPlayerNote(playerName) {
  const db = await getDb();
  if (!db.data.player_notes) db.data.player_notes = [];
  return (
    db.data.player_notes.find(
      (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
    ) || null
  );
}

export async function upsertPlayerNote(playerName, note, tags = []) {
  const db = await getDb();
  if (!db.data.player_notes) db.data.player_notes = [];

  const existingIndex = db.data.player_notes.findIndex(
    (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
  );

  const entry = {
    player_name: playerName,
    note: note || "",
    tags: tags || [],
    updated_at: new Date().toISOString(),
  };

  if (existingIndex !== -1) {
    db.data.player_notes[existingIndex] = {
      ...db.data.player_notes[existingIndex],
      ...entry,
    };
  } else {
    entry.id = generateId();
    entry.created_at = new Date().toISOString();
    db.data.player_notes.push(entry);
  }

  scheduleWrite();
  return entry;
}

export async function deletePlayerNote(playerName) {
  const db = await getDb();
  if (!db.data.player_notes) return false;

  const index = db.data.player_notes.findIndex(
    (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
  );
  if (index === -1) return false;

  db.data.player_notes.splice(index, 1);
  scheduleWrite();
  return true;
}


export async function getPlayerStats() {
  const db = await getDb();
  if (!db.data.player_stats) db.data.player_stats = [];
  return db.data.player_stats;
}

export async function getPlayerStat(playerName) {
  const db = await getDb();
  if (!db.data.player_stats) db.data.player_stats = [];
  return (
    db.data.player_stats.find(
      (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
    ) || null
  );
}

export async function recordPlayerSession(playerName, action) {
  const db = await getDb();
  if (!db.data.player_stats) db.data.player_stats = [];

  let playerStat = db.data.player_stats.find(
    (p) => p.player_name.toLowerCase() === playerName.toLowerCase(),
  );

  const now = new Date().toISOString();

  if (!playerStat) {
    playerStat = {
      id: generateId(),
      player_name: playerName,
      total_playtime_seconds: 0,
      session_count: 0,
      first_seen: now,
      last_seen: now,
      last_session_start: null,
      sessions: [],
    };
    db.data.player_stats.push(playerStat);
  }

  if (action === "connect") {
    playerStat.last_session_start = now;
    playerStat.last_seen = now;
    playerStat.session_count++;
  } else if (action === "disconnect" && playerStat.last_session_start) {
    const sessionStart = new Date(playerStat.last_session_start);
    const sessionEnd = new Date(now);
    const sessionDuration = Math.floor((sessionEnd - sessionStart) / 1000);

    playerStat.total_playtime_seconds += sessionDuration;
    playerStat.last_seen = now;

    if (!playerStat.sessions) playerStat.sessions = [];
    playerStat.sessions.unshift({
      start: playerStat.last_session_start,
      end: now,
      duration_seconds: sessionDuration,
    });
    if (playerStat.sessions.length > RETENTION.player_sessions) {
      playerStat.sessions = playerStat.sessions.slice(
        0,
        RETENTION.player_sessions,
      );
    }

    playerStat.last_session_start = null;
  }

  scheduleWrite();
  return playerStat;
}


export async function recordPerformanceSnapshot(snapshot) {
  const db = await getDb();
  if (!db.data.performance_history) db.data.performance_history = [];

  const entry = {
    timestamp: new Date().toISOString(),
    ...snapshot,
  };

  appendCapped(
    db.data.performance_history,
    entry,
    RETENTION.performance_history,
    { newest: false },
  );

  scheduleWrite();
  return entry;
}

export async function getPerformanceHistory(limit = 60) {
  const db = await getDb();
  if (!db.data.performance_history) return [];
  const safeLimit = parseClampedInteger(
    limit,
    60,
    1,
    RETENTION.performance_history,
  );
  return db.data.performance_history.slice(-safeLimit);
}

export async function clearPerformanceHistory() {
  const db = await getDb();
  db.data.performance_history = [];
  scheduleWrite();
}


export async function getModPresets() {
  const db = await getDb();
  if (!db.data.mod_presets) db.data.mod_presets = [];
  return db.data.mod_presets;
}

export async function createModPreset(
  name,
  description,
  mods,
  workshopIds,
  maps,
) {
  const db = await getDb();
  if (!db.data.mod_presets) db.data.mod_presets = [];

  const preset = {
    id: generateId(),
    name,
    description: description || "",
    mods: mods || [],
    workshop_ids: workshopIds || [],
    maps: maps || [],
    created_at: new Date().toISOString(),
  };

  db.data.mod_presets.push(preset);
  scheduleWrite();
  return preset;
}

export async function updateModPreset(id, updates) {
  const db = await getDb();
  if (!db.data.mod_presets) return null;

  const index = db.data.mod_presets.findIndex((p) => p.id === id);
  if (index === -1) return null;

  db.data.mod_presets[index] = {
    ...db.data.mod_presets[index],
    ...updates,
    updated_at: new Date().toISOString(),
  };
  scheduleWrite();
  return db.data.mod_presets[index];
}

export async function deleteModPreset(id) {
  const db = await getDb();
  if (!db.data.mod_presets) return false;

  const index = db.data.mod_presets.findIndex((p) => p.id === id);
  if (index === -1) return false;

  db.data.mod_presets.splice(index, 1);
  scheduleWrite();
  return true;
}


export async function getUserTemplates() {
  const db = await getDb();
  if (!db.data.user_templates) db.data.user_templates = [];
  return db.data.user_templates;
}

export async function getUserTemplate(id) {
  const db = await getDb();
  if (!db.data.user_templates) db.data.user_templates = [];
  return db.data.user_templates.find((t) => t.meta?.id === id) || null;
}

export async function saveUserTemplate(template) {
  const db = await getDb();
  if (!db.data.user_templates) db.data.user_templates = [];

  const index = db.data.user_templates.findIndex(
    (t) => t.meta?.id === template.meta?.id,
  );
  if (index === -1) {
    db.data.user_templates.push(template);
  } else {
    db.data.user_templates[index] = template;
  }
  scheduleWrite();
  return template;
}

export async function deleteUserTemplate(id) {
  const db = await getDb();
  if (!db.data.user_templates) return false;

  const index = db.data.user_templates.findIndex((t) => t.meta?.id === id);
  if (index === -1) return false;

  db.data.user_templates.splice(index, 1);
  scheduleWrite();
  return true;
}


export async function getSteamIdBans() {
  const db = await getDb();
  if (!db.data.steamid_bans) db.data.steamid_bans = [];
  return db.data.steamid_bans;
}

export async function addSteamIdBan(steamId, reason = null) {
  const db = await getDb();
  if (!db.data.steamid_bans) db.data.steamid_bans = [];

  if (db.data.steamid_bans.some((b) => b.steamId === steamId)) return;

  db.data.steamid_bans.push({
    steamId,
    reason: reason || null,
    banned_at: new Date().toISOString(),
  });
  scheduleWrite();
}

export async function removeSteamIdBan(steamId) {
  const db = await getDb();
  if (!db.data.steamid_bans) return false;

  const index = db.data.steamid_bans.findIndex((b) => b.steamId === steamId);
  if (index === -1) return false;

  db.data.steamid_bans.splice(index, 1);
  scheduleWrite();
  return true;
}
