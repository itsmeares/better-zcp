import fs from "fs";
import path from "path";
import { getActiveServer, getAllSettings } from "../database/init.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.ts";
import { backupWarningFor, createBackup } from "../utils/configBackup.ts";
import { escapeRegExp } from "../utils/regex.ts";
import { createLogger } from "../utils/logger.ts";
import {
  SFTP_CONFIG_PATH_KEY,
  acquireMirrorLock,
  beginRemoteConfigSession,
  getMirrorPath,
  isRemoteConfigConfigured,
  pushRemoteConfigFiles,
  validateRemoteConfigTransport,
} from "./remoteConfigFiles.ts";
import { ErrorCode } from "../utils/errorCodes.ts";

const log = createLogger("SandboxPersistence");

type JsonRecord = Record<string, any>;

export type ActiveServerContext = {
  activeServer: JsonRecord | null;
  serverConfigPath?: string;
  serverName?: string;
  configurationError?: ServerNotConfiguredError | RemoteConfigNotConfiguredError;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ServerNotConfiguredError extends Error {
  readonly code: string;

  constructor() {
    super("No active server configured");
    this.code = ErrorCode.SERVER_NOT_CONFIGURED;
  }
}

export class RemoteConfigNotConfiguredError extends Error {
  readonly code: string;

  constructor() {
    super(
      "This server is remote. Add its SFTP details and the remote Server folder under Settings > PanelBridge to edit its configuration from here.",
    );
    this.code = ErrorCode.REMOTE_CONFIG_NOT_CONFIGURED;
  }
}

export async function resolveRemoteConfigTransport(): Promise<any> {
  const settings = await getAllSettings();
  if (!isRemoteConfigConfigured(settings)) return null;
  return validateRemoteConfigTransport({
    host: settings.panelBridgeSftpHost,
    port: settings.panelBridgeSftpPort,
    username: settings.panelBridgeSftpUsername,
    password: settings.panelBridgeSftpPassword,
    configPath: settings[SFTP_CONFIG_PATH_KEY],
  });
}

export async function getServerConfigPath(
  activeServer?: JsonRecord | null,
  serverName?: string,
): Promise<string> {
  const resolvedActiveServer =
    activeServer === undefined ? await getActiveServer() : activeServer;

  if (resolvedActiveServer?.isRemote) {
    const transport = await resolveRemoteConfigTransport();
    if (transport) {
      return getMirrorPath(
        transport,
        serverName ?? (await getServerName(resolvedActiveServer)),
      );
    }
  }

  if (resolvedActiveServer?.serverConfigPath) {
    return resolvedActiveServer.serverConfigPath;
  }

  if (resolvedActiveServer?.zomboidDataPath) {
    return path.join(resolvedActiveServer.zomboidDataPath, "Server");
  }

  const settings = await getAllSettings();
  if (settings.serverConfigPath) {
    return settings.serverConfigPath;
  }
  if (settings.zomboidDataPath) {
    return path.join(settings.zomboidDataPath, "Server");
  }

  if (resolvedActiveServer?.isRemote) {
    throw new RemoteConfigNotConfiguredError();
  }

  throw new ServerNotConfiguredError();
}

export async function getServerName(
  activeServer?: JsonRecord | null,
): Promise<string> {
  const resolvedActiveServer =
    activeServer === undefined ? await getActiveServer() : activeServer;
  let raw;
  if (resolvedActiveServer?.serverName) {
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

export async function getActiveServerContext(): Promise<ActiveServerContext> {
  const activeServer = await getActiveServer();
  let serverConfigPath: string | undefined;
  let configurationError:
    | ServerNotConfiguredError
    | RemoteConfigNotConfiguredError
    | undefined;

  try {
    serverConfigPath = await getServerConfigPath(activeServer);
  } catch (error: unknown) {
    if (
      error instanceof ServerNotConfiguredError ||
      error instanceof RemoteConfigNotConfiguredError
    ) {
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
  return String(str).replace(/[\\"'\n\r\t\0\[\]]/g, (c) => {
    const escapes: Record<string, string> = {
      "\\": "\\\\",
      '"': '\\"',
      "'": "\\'",
      "\n": "\\n",
      "\r": "\\r",
      "\t": "\\t",
      "\0": "\\0",
      "[": "\\[",
      "]": "\\]",
    };
    return escapes[c] || c;
  });
}

function formatLuaNumber(newValue: number, originalValueStr?: string): string {
  const trimmed = originalValueStr
    ? originalValueStr.trim().replace(/,\s*$/, "")
    : "";
  if (Number.isInteger(newValue) && trimmed.includes(".")) {
    return newValue.toFixed(1);
  }
  return newValue.toString();
}

export function modifySandboxValue(
  originalContent: string,
  key: string,
  newValue: unknown,
  nestedBlock: string | null = null,
): string {
  let content = originalContent;

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    log.warn(`Invalid sandbox key skipped: ${key}`);
    return content;
  }

  function formatValue(originalValueStr: string): string {
    if (typeof newValue === "boolean") {
      return newValue.toString();
    } else if (typeof newValue === "number") {
      return formatLuaNumber(newValue, originalValueStr);
    } else {
      return `"${escapeLuaString(String(newValue))}"`;
    }
  }

  const escapedKey = escapeRegExp(key);

  if (nestedBlock) {
    const escapedBlock = escapeRegExp(nestedBlock);
    const blockStartPattern = new RegExp(`${escapedBlock}\\s*=\\s*\\{`);
    const blockStartMatch = content.match(blockStartPattern);
    if (blockStartMatch) {
      const blockStart = blockStartMatch.index ?? -1;
      if (blockStart < 0) return content;
      const blockEnd = content.indexOf(
        "}",
        blockStart + blockStartMatch[0].length,
      );
      if (blockEnd !== -1) {
        const before = content.substring(0, blockStart);
        const blockSection = content.substring(blockStart, blockEnd + 1);
        const after = content.substring(blockEnd + 1);
        const updatedBlock = blockSection.replace(
          new RegExp(
            `(^(?!\\s*--)[^\\n]*?)(${escapedKey})(\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)(,?)`,
            "m",
          ),
          (_: string, prefix: string, k: string, eq: string, oldVal: string, comma: string) =>
            `${prefix}${k}${eq}${formatValue(oldVal)}${comma}`,
        );
        content = before + updatedBlock + after;
      }
    }
  } else {
    const knownBlocks = [
      "ZombieLore",
      "ZombieConfig",
      "MultiplierConfig",
      "Map",
      "Basement",
      "Music",
      "Debug",
    ];
    const blockRanges: Array<{ start: number; end: number }> = [];
    for (const blockName of knownBlocks) {
      const blockPattern = new RegExp(`${escapeRegExp(blockName)}\\s*=\\s*\\{`);
      const blockMatch = content.match(blockPattern);
      if (blockMatch) {
        const start = blockMatch.index ?? -1;
        if (start < 0) continue;
        const end = content.indexOf("}", start + blockMatch[0].length);
        if (end !== -1) blockRanges.push({ start, end: end + 1 });
      }
    }

    const pattern = new RegExp(
      `(^\\s*)(${escapedKey})(\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)(,?)(\\s*(?:--.*)?$)`,
      "gm",
    );
    content = content.replace(
      pattern,
      (
        fullMatch: string,
        indent: string,
        k: string,
        eq: string,
        oldVal: string,
        comma: string,
        comment: string,
        offset: number,
      ) => {
        for (const range of blockRanges) {
          if (offset >= range.start && offset < range.end) return fullMatch;
        }
        return `${indent}${k}${eq}${formatValue(oldVal)}${comma}${comment}`;
      },
    );
  }

  return content;
}

async function writeSandboxValues(
  entries: Array<[string, any]>,
  configPath: string,
  serverName: string,
): Promise<JsonRecord> {
  const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);
  if (!fs.existsSync(filePath)) {
    return { persisted: false, reason: "SandboxVars.lua not found" };
  }

  let persisted = false;
  let reason = null;
  await withFileLock(filePath, async () => {
    const originalContent = fs.readFileSync(filePath, "utf-8");
    let content = originalContent;

    const missing = entries
      .map(([key]: [string, any]) => key)
      .filter(
        (key: string) => !new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "m").test(content),
      );
    if (missing.length > 0) {
      reason = `not present in SandboxVars.lua: ${missing.join(", ")}`;
      return;
    }

    for (const [key, value] of entries) {
      content = modifySandboxValue(content, key, value, null);
    }
    if (content === originalContent) {
      reason = "values already match";
      return;
    }
    const backupWarning = backupWarningFor(
      await createBackup(configPath, `${serverName}_SandboxVars.lua`),
    );
    writeFileAtomic(filePath, content, "utf-8");
    persisted = true;
    if (backupWarning) reason = backupWarning;
  });

  return { persisted, reason };
}

export async function persistSandboxValues(values: JsonRecord): Promise<JsonRecord> {
  const entries = Object.entries(values || {});
  if (entries.length === 0) return { persisted: false, reason: "nothing to do" };

  const activeServer = await getActiveServer();
  if (activeServer?.isRemote) {
    const transport = await resolveRemoteConfigTransport();
    if (!transport) {
      return { persisted: false, reason: "remote server filesystem" };
    }
    const serverName = await getServerName();
    const release = await acquireMirrorLock();
    try {
      const session = await beginRemoteConfigSession(transport, serverName, {
        fresh: true,
      });
      const result = await writeSandboxValues(entries, session.mirrorDir, serverName);
      if (result.persisted) {
        await pushRemoteConfigFiles(transport, serverName, session);
      }
      return result;
    } catch (err: unknown) {
      return { persisted: false, reason: sanitizeError(errorMessage(err)) };
    } finally {
      release();
    }
  }

  try {
    return await writeSandboxValues(
      entries,
      await getServerConfigPath(),
      await getServerName(),
    );
  } catch (err: unknown) {
    if (err instanceof ServerNotConfiguredError) {
      return { persisted: false, reason: "no server configured" };
    }
    throw err;
  }
}
