import crypto from "crypto";
import fs from "fs";
import path from "path";
import SftpClient from "ssh2-sftp-client";
import { createLogger } from "../utils/logger.js";
import { getDataPaths } from "../utils/paths.js";

const log = createLogger("RemoteConfig");

export const SFTP_CONFIG_PATH_KEY = "panelBridgeSftpConfigPath";

const CONFIG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const CONFIG_EXTENSIONS = [".ini", ".lua"];
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const LIST_MAX = 200;

const MIRROR_FRESH_MS = 5000;

const MAX_REMOTE_PATH_LENGTH = 500;

function safeRemoteDir(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_REMOTE_PATH_LENGTH ||
    !value.startsWith("/") ||
    value.includes("..") ||
    value.includes("\\")
  ) {
    throw new Error(
      "Remote config folder must be an absolute POSIX path without traversal",
    );
  }
  return value.replace(/\/+$/, "") || "/";
}

function assertConfigFileName(name) {
  if (typeof name !== "string" || !CONFIG_NAME_PATTERN.test(name)) {
    throw new Error("Invalid server config file name");
  }
  if (!CONFIG_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
    throw new Error("Only .ini and .lua server config files can be synced");
  }
  return name;
}

export function validateRemoteConfigTransport(config) {
  const host = typeof config?.host === "string" ? config.host.trim() : "";
  const username =
    typeof config?.username === "string" ? config.username.trim() : "";
  const port = Number(config?.port || 22);
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) {
    throw new Error("A valid SFTP host is required");
  }
  if (!username || username.length > 128 || /[\r\n]/.test(username)) {
    throw new Error("A valid SFTP username is required");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SFTP port must be between 1 and 65535");
  }
  if (!config?.configPath) {
    throw new Error("A remote server config folder is required");
  }
  return {
    host,
    port,
    username,
    password: typeof config?.password === "string" ? config.password : "",
    configPath: safeRemoteDir(config.configPath),
  };
}

export function isRemoteConfigConfigured(settings) {
  return Boolean(settings?.panelBridgeSftpHost && settings?.[SFTP_CONFIG_PATH_KEY]);
}

export function getMirrorPath(config, serverName) {
  const key = crypto
    .createHash("sha256")
    .update(`${config.host}:${config.port}:${config.username}:${config.configPath}:${serverName}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(getDataPaths().dataDir, "remote-config", key);
}

export function mirroredFileNames(serverName) {
  const base = String(serverName || "").trim();
  if (!base || !CONFIG_NAME_PATTERN.test(base)) {
    throw new Error("Server name is not usable as a config file name");
  }
  return [
    `${base}.ini`,
    `${base}_SandboxVars.lua`,
    `${base}_spawnpoints.lua`,
    `${base}_spawnregions.lua`,
  ].map(assertConfigFileName);
}

async function withClient(config, handler) {
  const client = new SftpClient("RemoteConfigFiles");
  try {
    await client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: 10000,
    });
    return await handler(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

export async function listRemoteConfigFiles(rawConfig) {
  const config = validateRemoteConfigTransport(rawConfig);
  return withClient(config, async (client) => {
    const entries = await client.list(config.configPath);
    const files = entries
      .filter((entry) => entry.type === "-")
      .filter((entry) =>
        CONFIG_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext)),
      )
      .map((entry) => ({
        name: entry.name,
        size: entry.size,
        modifiedAt: entry.modifyTime
          ? new Date(entry.modifyTime).toISOString()
          : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, LIST_MAX);
    return { configPath: config.configPath, files };
  });
}

export async function pullRemoteConfigFiles(rawConfig, serverName) {
  const config = validateRemoteConfigTransport(rawConfig);
  const names = mirroredFileNames(serverName);
  const mirrorDir = getMirrorPath(config, serverName);
  fs.mkdirSync(mirrorDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(mirrorDir, 0o700);
  } catch {
    /* best-effort: Windows / network shares */
  }

  const manifest = {};
  await withClient(config, async (client) => {
    for (const name of names) {
      const remotePath = `${config.configPath}/${name}`;
      const localPath = path.join(mirrorDir, name);
      let stats = null;
      try {
        stats = await client.stat(remotePath);
      } catch {
        // Absent remotely is normal — spawnpoints/spawnregions are optional.
      }
      if (!stats || stats.isDirectory) {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        manifest[name] = null;
        continue;
      }
      if (Number(stats.size) > MAX_CONFIG_BYTES) {
        throw new Error(`${name} is larger than the ${MAX_CONFIG_BYTES} byte limit`);
      }
      const buffer = await client.get(remotePath);
      fs.writeFileSync(
        localPath,
        Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? "")),
        { mode: 0o600 },
      );
      try {
        fs.chmodSync(localPath, 0o600);
      } catch {
        /* best-effort: Windows / network shares */
      }
      manifest[name] = hashFile(localPath);
    }
  });
  return { mirrorDir, manifest, pulledAt: Date.now() };
}

export async function pushRemoteConfigFiles(rawConfig, serverName, session) {
  const config = validateRemoteConfigTransport(rawConfig);
  const names = mirroredFileNames(serverName);
  const mirrorDir = session?.mirrorDir || getMirrorPath(config, serverName);
  const manifest = session?.manifest || {};

  const changed = names.filter((name) => {
    const current = hashFile(path.join(mirrorDir, name));
    return current !== null && current !== (manifest[name] ?? null);
  });
  if (changed.length === 0) return { pushed: [] };

  await withClient(config, async (client) => {
    for (const name of changed) {
      const localPath = path.join(mirrorDir, name);
      const remotePath = `${config.configPath}/${name}`;
      const tempPath = `${remotePath}.panel-tmp`;
      await client.put(fs.readFileSync(localPath), tempPath);
      try {
        await client.posixRename(tempPath, remotePath);
      } catch {
        try {
          await client.delete(remotePath);
        } catch {
          // First write of a file that does not exist remotely yet.
        }
        await client.rename(tempPath, remotePath);
      }
      manifest[name] = hashFile(localPath);
    }
  });
  log.info(`Pushed ${changed.length} config file(s) to ${config.host}`);
  return { pushed: changed };
}

let lockChain = Promise.resolve();

export function acquireMirrorLock() {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const waitFor = lockChain;
  lockChain = lockChain.then(() => held);
  return waitFor.then(() => release);
}

let lastSession = null;

function transportFingerprint(config) {
  return `${config.host}:${config.port}:${config.username}:${config.configPath}`;
}

export async function beginRemoteConfigSession(config, serverName, { fresh }) {
  const transportKey = transportFingerprint(config);
  if (
    !fresh &&
    lastSession &&
    lastSession.serverName === serverName &&
    lastSession.transportKey === transportKey &&
    Date.now() - lastSession.pulledAt < MIRROR_FRESH_MS
  ) {
    return lastSession;
  }
  const pulled = await pullRemoteConfigFiles(config, serverName);
  lastSession = { ...pulled, serverName, transportKey };
  return lastSession;
}

export function resetRemoteConfigSession() {
  lastSession = null;
}
