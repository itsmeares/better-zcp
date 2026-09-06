import fs from "node:fs";
import path from "node:path";
import { getDataPaths } from "./paths.js";
import { readUiSecretFile, writeUiSecretFile } from "./uiSecretFile.js";

interface Logger {
  warn?: (message: string) => unknown;
}

interface ServerRecord {
  id?: string | number;
  rconPassword?: unknown;
  [key: string]: unknown;
}

export interface DatabaseData {
  servers?: ServerRecord[];
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

function secretsDir(): string {
  return path.join(getDataPaths().dataDir, "server-secrets");
}

function serverSecretPath(serverId: string | number): string {
  const safeId = String(serverId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(secretsDir(), `${safeId}.secret`);
}

function ensureSecretsDir(): void {
  const dir = secretsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

function readServerSecret(
  serverId: string | number,
  log?: Logger | null,
): string | null {
  const filePath = serverSecretPath(serverId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || null;
  } catch (error) {
    log?.warn?.(
      `Could not read the RCON password file for server ${serverId} ` +
        `(${filePath}): ${error instanceof Error ? error.message : String(error)}. Treating it as unset — re-enter ` +
        "it in the server's settings.",
    );
    return null;
  }
}

function writeServerSecret(serverId: string | number, value: unknown): void {
  const filePath = serverSecretPath(serverId);
  if (value == null || value === "") {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already absent */
    }
    return;
  }
  try {
    if (fs.readFileSync(filePath, "utf8") === String(value)) return;
  } catch {
    /* doesn't exist yet or unreadable — fall through and write it */
  }
  ensureSecretsDir();
  fs.writeFileSync(filePath, String(value), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

export function deleteServerSecret(serverId: string | number): void {
  try {
    fs.unlinkSync(serverSecretPath(serverId));
  } catch {
    /* already absent, fine */
  }
}

export function rehydrateRconSecrets(
  data: DatabaseData,
  log?: Logger | null,
): DatabaseData {
  for (const server of data.servers || []) {
    if (!server.rconPassword && server.id !== undefined) {
      const fromFile = readServerSecret(server.id, log);
      if (fromFile) server.rconPassword = fromFile;
    }
  }
  if (!data.settings) data.settings = {};
  if (!data.settings.rconPassword) {
    const fromFile = readUiSecretFile("rconPassword", log);
    if (fromFile) data.settings.rconPassword = fromFile;
  }
  return data;
}

export function redactRconSecretsForWrite(data: DatabaseData): DatabaseData {
  const redactedServers = (data.servers || []).map((server) => {
    if (server.rconPassword !== undefined && server.id !== undefined) {
      writeServerSecret(server.id, server.rconPassword);
      const { rconPassword: _rconPassword, ...rest } = server;
      return rest;
    }
    return server;
  });

  let redactedSettings = data.settings;
  if (data.settings && data.settings.rconPassword !== undefined) {
    writeUiSecretFile("rconPassword", data.settings.rconPassword);
    const { rconPassword: _rconPassword, ...rest } = data.settings;
    redactedSettings = rest;
  }

  return { ...data, servers: redactedServers, settings: redactedSettings };
}
