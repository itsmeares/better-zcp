import fs from "fs";
import path from "path";
import { getCurrentServer, getAllSettings } from "../database/init.ts";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.ts";
import { backupWarningFor, createBackup } from "../utils/configBackup.ts";
import { ErrorCode } from "../utils/errorCodes.ts";


type JsonRecord = Record<string, any>;

export type ActiveServerContext = {
  activeServer: JsonRecord | null;
  serverConfigPath?: string;
  serverName?: string;
  configurationError?: ServerNotConfiguredError;
};

export class ServerNotConfiguredError extends Error {
  readonly code: string;

  constructor() {
    super("No active server configured");
    this.code = ErrorCode.SERVER_NOT_CONFIGURED;
  }
}

export async function getServerConfigPath(
  activeServer?: JsonRecord | null,
  _serverName?: string,
): Promise<string> {
  const resolvedActiveServer =
    activeServer === undefined ? await getCurrentServer() : activeServer;

  if (resolvedActiveServer?.serverConfigPath) {
    return resolvedActiveServer.serverConfigPath;
  }

  if (resolvedActiveServer?.zomboidDataPath) {
    return path.join(resolvedActiveServer.zomboidDataPath, "Server");
  }

  if (resolvedActiveServer) throw new ServerNotConfiguredError();

  const settings = await getAllSettings();
  if (settings.serverConfigPath) {
    return settings.serverConfigPath;
  }
  if (settings.zomboidDataPath) {
    return path.join(settings.zomboidDataPath, "Server");
  }

  throw new ServerNotConfiguredError();
}

export async function getServerName(
  activeServer?: JsonRecord | null,
): Promise<string> {
  const resolvedActiveServer =
    activeServer === undefined ? await getCurrentServer() : activeServer;
  let raw;
  if (resolvedActiveServer) {
    raw = resolvedActiveServer.serverName;
  } else {
    const settings = await getAllSettings();
    raw = settings.serverName;
  }
  if (!raw) {
    throw new ServerNotConfiguredError();
  }

  const safe = path.basename(raw);
  if (safe !== raw || !safe) {
    throw new Error("Configured server name contains invalid path characters");
  }
  return safe;
}

export async function getCurrentServerContext(): Promise<ActiveServerContext> {
  const activeServer = await getCurrentServer();
  let serverConfigPath: string | undefined;
  let configurationError: ServerNotConfiguredError | undefined;

  try {
    serverConfigPath = await getServerConfigPath(activeServer);
  } catch (error: unknown) {
    if (error instanceof ServerNotConfiguredError) {
      configurationError = error;
    } else {
      throw error;
    }
  }

  let serverName: string | undefined;

  try {
    serverName = await getServerName(activeServer);
  } catch (error: unknown) {
    if (!(error instanceof ServerNotConfiguredError)) {
      throw error;
    }
  }

  return { activeServer, serverConfigPath, serverName, configurationError };
}

export function escapeLuaString(str: unknown): string {
  return String(str).replace(/[\\"\n\r\t\0]/g, (c) => ({
    "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t", "\0": "\\000",
  })[c]!);
}

// Ignore strings and comments while locating table fields, keeping the original offsets.
function maskedLua(content: string): string {
  return content.replace(/--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\[(=*)\[[\s\S]*?\]\2\]/g,
    (value) => value.replace(/[^\n]/g, " "));
}

function tableFields(content: string, start: number) {
  const mask = maskedLua(content);
  const fields: Array<{ name: string; start: number; end: number }> = [];
  let depth = 1, fieldStart = start + 1;
  for (let i = start + 1; i < mask.length; i++) {
    if (mask[i] === "{") depth++;
    if (mask[i] === "}") depth--;
    if (depth === 0 || (depth === 1 && (mask[i] === "," || mask[i] === ";"))) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(mask.slice(fieldStart, i));
      if (match) {
        let valueStart = fieldStart + match[0].length;
        while (/\s/.test(content[valueStart] || "") && valueStart < i) valueStart++;
        fields.push({ name: match[1], start: valueStart, end: i });
      }
      fieldStart = i + 1;
    }
    if (depth === 0) return { fields, end: i };
  }
  throw new Error("SandboxVars has an unclosed table. Repair the file before editing options.");
}

export function modifySandboxValue(
  content: string, key: string, value: unknown, nestedBlock: string | null = null, create = false,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || (nestedBlock && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(nestedBlock))) {
    throw new Error("Invalid sandbox option name.");
  }
  if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error("Sandbox value must be a finite number, boolean, or string.");
  }
  const literal = typeof value === "string" ? `"${escapeLuaString(value)}"` : String(value);
  const root = /\bSandboxVars\s*=\s*\{/.exec(maskedLua(content));
  if (!root) throw new Error("SandboxVars table was not found.");
  const rootStart = root.index + root[0].length - 1;
  let tableStart = rootStart;
  if (nestedBlock) {
    const group = tableFields(content, rootStart).fields.find((field) => field.name === nestedBlock);
    if (!group) {
      if (!create) return content;
      const end = tableFields(content, rootStart).end;
      return insertField(content, end, `${nestedBlock} = { ${key} = ${literal}, }`);
    }
    if (maskedLua(content)[group.start] !== "{") throw new Error("Sandbox option group is not a table.");
    tableStart = group.start;
  }
  const { fields, end } = tableFields(content, tableStart);
  const field = fields.find((entry) => entry.name === key);
  if (!field) return create ? insertField(content, end, `${key} = ${literal}`) : content;
  const raw = content.slice(field.start, field.end);
  const primitive = /^\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|true\b|false\b|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(raw);
  if (!primitive || maskedLua(raw.slice(primitive[0].length)).trim()) throw new Error("Sandbox option value is not a literal. Edit the Lua file directly.");
  return content.slice(0, field.start) + literal + raw.slice(primitive[0].length) + content.slice(field.end);
}

function insertField(content: string, end: number, field: string): string {
  const prefix = content.slice(0, end);
  const mask = maskedLua(prefix).trimEnd();
  const separator = ["{", ",", ";"].includes(mask.at(-1) || "") ? "" : ",";
  return prefix + separator + `\n    ${field},\n` + content.slice(end);
}

export async function persistSandboxOption(name: string, value: unknown) {
  const parts = name.split(".");
  if (parts.length > 2 || !parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) throw new Error("Invalid sandbox option name.");
  const configPath = await getServerConfigPath();
  const filename = `${await getServerName()}_SandboxVars.lua`;
  const file = path.join(configPath, filename);
  return withFileLock(file, async () => {
    const original = fs.readFileSync(file, "utf8");
    const content = modifySandboxValue(original, parts.at(-1)!, value, parts.length === 2 ? parts[0] : null, true);
    if (content === original) return { persisted: true, changed: false };
    const backupWarning = backupWarningFor(await createBackup(configPath, filename));
    writeFileAtomic(file, content, "utf8");
    return { persisted: true, changed: true, ...(backupWarning ? { backupWarning } : {}) };
  });
}
