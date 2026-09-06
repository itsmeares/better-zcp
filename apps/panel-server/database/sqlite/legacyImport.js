import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSqliteSnapshotStore } from "./snapshotStore.js";

const EXPECTED_TOP_LEVEL_KEYS = new Set([
  "command_history",
  "scheduled_tasks",
  "schedule_history",
  "player_logs",
  "server_events",
  "tracked_mods",
  "ignored_mods",
  "ignored_mod_pairs",
  "servers",
  "player_notes",
  "player_stats",
  "mod_presets",
  "user_templates",
  "steamid_bans",
  "performance_history",
  "bridge_logs",
  "discord_webhooks",
  "users",
  "roles",
  "settings",
  "_schemaVersion",
]);

const SECRET_SETTING_FILES = {
  jwtSecret: "jwt.secret",
  rconPassword: "rconPassword.secret",
  panelBridgeSftpPassword: "panelBridgeSftpPassword.secret",
  steamSessionId: "steamSessionId.secret",
  steamLoginSecure: "steamLoginSecure.secret",
  discordBotToken: "discordBotToken.secret",
  oidcClientSecret: "oidcClientSecret.secret",
};

const SECRET_SETTINGS_REQUIRING_MANUAL_REENTRY = new Set(["steamApiKey"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeServerId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function addSecret(secretFiles, omittedSecrets, field, value, fileName) {
  if (value === undefined || value === null || value === "") return;
  if (fileName) {
    secretFiles.push({ fileName, value });
  }
  omittedSecrets.push({ field, storage: fileName ? "secret-file" : "manual" });
}

export function prepareLegacyImport(legacyData) {
  if (!isRecord(legacyData)) {
    throw new TypeError("Legacy database must contain a JSON object");
  }

  const data = cloneJson(legacyData);
  const secretFiles = [];
  const omittedSecrets = [];
  const settings = isRecord(data.settings) ? data.settings : null;

  if (settings) {
    for (const [key, fileName] of Object.entries(SECRET_SETTING_FILES)) {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
      addSecret(secretFiles, omittedSecrets, `settings.${key}`, settings[key], fileName);
      delete settings[key];
    }

    for (const key of SECRET_SETTINGS_REQUIRING_MANUAL_REENTRY) {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
      addSecret(secretFiles, omittedSecrets, `settings.${key}`, settings[key], null);
      delete settings[key];
    }
  }

  for (const [index, server] of (Array.isArray(data.servers) ? data.servers : []).entries()) {
    if (!isRecord(server) || !Object.prototype.hasOwnProperty.call(server, "rconPassword")) continue;
    const serverId = server.id ?? `server-${index + 1}`;
    addSecret(
      secretFiles,
      omittedSecrets,
      `servers[${index}].rconPassword`,
      server.rconPassword,
      `server-secrets/${safeServerId(serverId)}.secret`,
    );
    delete server.rconPassword;
  }

  const unknownKeys = Object.keys(data).filter((key) => !EXPECTED_TOP_LEVEL_KEYS.has(key));
  return { data, secretFiles, omittedSecrets, unknownKeys };
}

function writeSecretFiles(dataDir, secretFiles) {
  const created = [];
  try {
    for (const secret of secretFiles) {
      const filePath = path.join(dataDir, secret.fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, String(secret.value), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Windows and some mounted filesystems do not support POSIX modes.
      }
      created.push(filePath);
    }
    return created;
  } catch (error) {
    for (const filePath of created) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort rollback of files created during this import.
      }
    }
    throw new Error(`Could not write imported secret files: ${error.message}`);
  }
}

function countCollections(data) {
  return Object.fromEntries(
    ["servers", "users", "roles", "scheduled_tasks"].map((key) => [
      key,
      Array.isArray(data[key]) ? data[key].length : 0,
    ]),
  );
}

function summarizeLegacyImport(prepared, { sourcePath, targetPath, applied }) {
  return {
    sourcePath,
    targetPath,
    applied,
    collections: countCollections(prepared.data),
    unknownKeys: prepared.unknownKeys,
    omittedSecrets: prepared.omittedSecrets,
  };
}

export async function importLegacyDatabase({ sourcePath, targetPath, apply = false }) {
  if (typeof sourcePath !== "string" || typeof targetPath !== "string") {
    throw new TypeError("Both sourcePath and targetPath are required");
  }

  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (source === target) {
    throw new Error("Source and target must be different files");
  }
  if (fs.existsSync(target)) {
    throw new Error(`Refusing to overwrite an existing SQLite database: ${target}`);
  }

  let legacyData;
  let sourceHandle;
  try {
    sourceHandle = fs.openSync(source, "r");
    if (!fs.fstatSync(sourceHandle).isFile()) {
      throw new Error(`Legacy database was not found: ${source}`);
    }
    legacyData = JSON.parse(fs.readFileSync(sourceHandle, "utf8"));
  } catch (error) {
    throw new Error(`Could not read legacy database JSON: ${error.message}`);
  } finally {
    if (sourceHandle !== undefined) fs.closeSync(sourceHandle);
  }

  const prepared = prepareLegacyImport(legacyData);
  const summary = summarizeLegacyImport(prepared, {
    sourcePath: source,
    targetPath: target,
    applied: false,
  });
  if (!apply) return summary;

  const temporaryTarget = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let store;
  let createdSecretFiles = [];
  try {
    store = createSqliteSnapshotStore(temporaryTarget);
    await store.write(prepared.data);
    store.close();
    store = null;

    createdSecretFiles = writeSecretFiles(path.dirname(target), prepared.secretFiles);
    // A hard link gives us rename-without-replace semantics: a target that
    // appears after the initial existence check is never overwritten.
    fs.linkSync(temporaryTarget, target);
    fs.unlinkSync(temporaryTarget);
    return { ...summary, applied: true };
  } catch (error) {
    store?.close();
    try {
      fs.unlinkSync(temporaryTarget);
    } catch {
      // The temporary database may already have been removed after a failed rename.
    }
    for (const filePath of createdSecretFiles) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort rollback of files created during this import.
      }
    }
    throw error;
  }
}
