import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("API:Files");
import { getActiveServer, getAllSettings, getRoleByName } from "../database/init.js";
import {
  sanitizeError,
  sanitizeErrorParams,
  SENSITIVE_FIELD_RE,
  omitSensitiveFields,
  maskSensitiveObject,
  isMaskedSecret,
  maskSecretValue,
} from "../utils/sanitize.ts";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.ts";
import {
  getBackupPath,
  createBackup,
  backupWarningFor,
  writeIniWithBackup,
} from "../utils/configBackup.ts";
import { escapeRegExp } from "../utils/regex.ts";
import { findDuplicateIniKeys } from "../utils/iniDuplicateKeys.ts";
import { confineToRoots } from "../utils/browseRoots.ts";
import {
  SFTP_CONFIG_PATH_KEY,
  acquireMirrorLock,
  beginRemoteConfigSession,
  getMirrorPath,
  isRemoteConfigConfigured,
  pushRemoteConfigFiles,
  validateRemoteConfigTransport,
} from "../services/remoteConfigFiles.ts";
import {
  requireStoppedForLocalConfigMutation,
  warnRunningForLocalConfigEdit,
} from "../services/configMutationGuard.ts";
import { requirePermission } from "../services/permissions.ts";
import { ErrorCode } from "../utils/errorCodes.ts";

const router = express.Router();

type JsonRecord = Record<string, any>;
type SandboxChangeSet = JsonRecord;
type SpawnPoint = {
  worldX: number;
  worldY: number;
  posX: number;
  posY: number;
  posZ: number;
};
type SpawnRegion = {
  name: string;
  file: string;
  isServerFile: boolean;
};
type MaskedIniResult =
  | { ok: true; content: string }
  | { ok: false; reason: "unresolvable" | "removed"; key: string };
type SandboxRepairResult =
  | { alreadyValid: true }
  | { alreadyValid: false; repaired: false; error: string; code: string; params?: JsonRecord }
  | { alreadyValid: false; repaired: true; changes: string[]; backupName?: string };
type ServerFilesRequest = Request & {
  user?: { role?: string } | null;
  configEditRestartWarning?: boolean;
};

declare global {
  namespace Express {
    interface Request {
      user?: { role?: string } | null;
      configEditRestartWarning?: boolean;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.use(requirePermission("serverfiles.manage"));

const INI_KEY_CAPABILITY: Record<string, string> = {
  RCONPassword: "server.configure",
  RCONPort: "server.configure",
  DefaultPort: "server.configure",
  UDPPort: "server.configure",
  UPnP: "server.configure",
};

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

const LOCAL_ONLY_PATHS = new Set(["/browse-files", "/image-preview"]);

async function resolveRemoteConfigTransport(): Promise<any> {
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

router.use(async (req: ServerFilesRequest, res: Response, next: NextFunction) => {
  try {
    await getServerConfigPath();
  } catch (err: unknown) {
    if (err instanceof ServerNotConfiguredError) {
      return res.status(404).json({ error: errorMessage(err), code: err.code });
    }
    if (err instanceof RemoteConfigNotConfiguredError) {
      return res.status(400).json({ error: errorMessage(err), code: err.code });
    }
    return next(err);
  }
  next();
});

router.use(async (req: ServerFilesRequest, res: Response, next: NextFunction) => {
  let activeServer;
  try {
    activeServer = await getActiveServer();
  } catch (err: unknown) {
    return next(err);
  }
  if (!activeServer?.isRemote) return next();

  if (LOCAL_ONLY_PATHS.has(req.path)) {
    return res.status(400).json({
      error:
        "Browsing the server filesystem is not available for remote servers.",
      code: ErrorCode.REMOTE_BROWSE_NOT_AVAILABLE,
    });
  }

  let transport;
  try {
    transport = await resolveRemoteConfigTransport();
  } catch (err: unknown) {
    return res.status(400).json({ error: sanitizeError(errorMessage(err)) });
  }
  if (!transport) {
    return res.status(400).json({
      code: "REMOTE_CONFIG_NOT_CONFIGURED",
      error:
        "This server is remote. Add its SFTP details and the remote Server folder under Settings > PanelBridge to edit its configuration from here.",
    });
  }

  const serverName = await getServerName();
  const release = await acquireMirrorLock();
  let session;
  try {
    session = await beginRemoteConfigSession(transport, serverName, {
      fresh: req.method !== "GET",
    });
  } catch (err: unknown) {
    release();
    log.error(`Remote config pull failed: ${errorMessage(err)}`);
    return res.status(502).json({
      error: `Could not read the remote server config folder: ${sanitizeError(errorMessage(err))}`,
    });
  }

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    void (async () => {
      try {
        if (req.method !== "GET" && res.statusCode < 400) {
          await pushRemoteConfigFiles(transport, serverName, session);
        }
      } catch (err: unknown) {
        log.error(`Remote config push failed: ${errorMessage(err)}`);
      } finally {
        release();
      }
    })();
  };
  const watchdog = setTimeout(finish, 60000);
  watchdog.unref?.();
  res.on("finish", finish);
  res.on("close", finish);
  next();
});

const LOCAL_CONFIG_MUTATIONS = new Set([
  "PUT /ini",
  "PUT /sandbox",
  "POST /sandbox/repair",
  "PUT /spawnpoints",
  "PUT /spawnregions",
  "PUT /raw/ini",
  "PUT /raw/sandbox",
  "PUT /raw/spawnpoints",
  "PUT /raw/spawnregions",
]);

function isLocalConfigOverwrite(req: Request): boolean {
  if (req.method === "POST" && /^\/templates\/[^/]+\/apply$/.test(req.path)) {
    return true;
  }
  return req.method === "POST" && /^\/restore\/[^/]+$/.test(req.path);
}

function isLocalConfigEdit(req: Request): boolean {
  return LOCAL_CONFIG_MUTATIONS.has(`${req.method} ${req.path}`);
}

export function isLocalConfigMutation(req: Request): boolean {
  return isLocalConfigEdit(req) || isLocalConfigOverwrite(req);
}

export {
  requireStoppedForLocalConfigMutation,
  isLocalConfigEdit,
  isLocalConfigOverwrite,
};
router.use((req: ServerFilesRequest, res: Response, next: NextFunction) => {
  if (isLocalConfigOverwrite(req)) {
    return requireStoppedForLocalConfigMutation(req, res, next);
  }
  if (isLocalConfigEdit(req)) {
    return warnRunningForLocalConfigEdit(req, res, next);
  }
  return next();
});

function escapeLuaString(str: unknown): string {
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

const LUA_UNESCAPES: Record<string, string> = {
  "\\": "\\",
  '"': '"',
  "'": "'",
  n: "\n",
  r: "\r",
  t: "\t",
  0: "\0",
  "[": "[",
  "]": "]",
};

function unescapeLuaString(value: unknown): string {
  const str = String(value);
  if (!/^"[\s\S]*"$|^'[\s\S]*'$/.test(str)) {
    return str.replace(/^["']|["']$/g, "");
  }
  return str
    .slice(1, -1)
    .replace(/\\([\s\S])/g, (match, c) =>
      Object.prototype.hasOwnProperty.call(LUA_UNESCAPES, c)
        ? LUA_UNESCAPES[c]
        : match,
    );
}

export async function getServerConfigPath() {
  const activeServer = await getActiveServer();

  if (activeServer?.isRemote) {
    const transport = await resolveRemoteConfigTransport();
    if (transport) {
      return getMirrorPath(transport, await getServerName());
    }
  }

  if (activeServer?.serverConfigPath) {
    return activeServer.serverConfigPath;
  }

  if (activeServer?.zomboidDataPath) {
    return path.join(activeServer.zomboidDataPath, "Server");
  }

  const settings = await getAllSettings();
  if (settings.serverConfigPath) {
    return settings.serverConfigPath;
  }
  if (settings.zomboidDataPath) {
    return path.join(settings.zomboidDataPath, "Server");
  }

  if (activeServer?.isRemote) {
    throw new RemoteConfigNotConfiguredError();
  }

  throw new ServerNotConfiguredError();
}

export async function getServerName() {
  const activeServer = await getActiveServer();
  let raw;
  if (activeServer?.serverName) {
    raw = activeServer.serverName;
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


export function parseIni(content: string): JsonRecord {
  const result: JsonRecord = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      result[key] = value;
    }
  }

  return result;
}

export function stripSensitiveIniLines(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      return true;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) return true;
    const key = trimmed.substring(0, eqIndex).trim();
    return !SENSITIVE_FIELD_RE.test(key);
  });
  return kept.join("\n");
}

export function maskSensitiveIniLines(content: string): string {
  const lines = content.split(/\r?\n/);
  const masked = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      return line;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) return line;
    const key = line.substring(0, eqIndex).trim();
    const value = line.substring(eqIndex + 1);
    if (!SENSITIVE_FIELD_RE.test(key) || !value) return line;
    return `${line.substring(0, eqIndex + 1)}${maskSecretValue(value)}`;
  });
  return masked.join("\n");
}

export function reconcileMaskedIniLines(
  incomingContent: string,
  liveContent: string,
): MaskedIniResult {
  const indexIniLines = (text: string) => {
    const lines = text.split(/\r?\n/);
    const byKey = new Map();
    lines.forEach((line: string, index: number) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) return;
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ index, line, value });
    });
    return byKey;
  };

  const incomingByKey = indexIniLines(incomingContent);
  const liveByKey = indexIniLines(liveContent);
  const outLines = incomingContent.split(/\r?\n/);

  for (const [key, entries] of incomingByKey) {
    if (!SENSITIVE_FIELD_RE.test(key)) continue;
    const maskedEntries = entries.filter((e: { value: string }) => isMaskedSecret(e.value));
    if (maskedEntries.length === 0) continue;

    const liveEntries = liveByKey.get(key) || [];
    if (maskedEntries.length > 1 || liveEntries.length !== 1) {
      return { ok: false, reason: "unresolvable", key };
    }
    outLines[maskedEntries[0].index] = liveEntries[0].line;
  }

  for (const [key, liveEntries] of liveByKey) {
    if (!SENSITIVE_FIELD_RE.test(key)) continue;
    if (liveEntries.length !== 1 || !liveEntries[0].value) continue;
    if (!incomingByKey.has(key)) {
      return { ok: false, reason: "removed", key };
    }
  }

  return { ok: true, content: outLines.join("\n") };
}

export function toIni(obj: JsonRecord, originalContent = ""): string {
  if (originalContent) {
    const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n";
    const lines = originalContent.split(/\r?\n/);
    const result = [];
    const written = new Set();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
        result.push(line);
        continue;
      }

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        if (key in obj) {
          const safeValue = String(obj[key]).replace(/[\r\n]/g, "");
          const lineEqIndex = line.indexOf("=");
          const afterEq = line.slice(lineEqIndex + 1);
          const valueMatch = afterEq.match(/^(\s*)([\s\S]*?)(\s*)$/);
          if (!valueMatch) {
            result.push(line);
            continue;
          }
          const [, leadingWs, , trailingWs] = valueMatch;
          result.push(
            `${line.slice(0, lineEqIndex + 1)}${leadingWs}${safeValue}${trailingWs}`,
          );
          written.add(key);
        } else {
          result.push(line);
        }
      } else {
        result.push(line);
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      if (!written.has(key)) {
        if (value === "" || value === undefined || value === null) continue;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          log.warn(`Invalid INI key skipped: ${key}`);
          continue;
        }
        const safeValue = String(value).replace(/[\r\n]/g, "");
        result.push(`${key}=${safeValue}`);
      }
    }

    return result.join(lineEnding);
  }

  return Object.entries(obj)
    .filter(([key]) => {
      if (obj[key] === "" || obj[key] === undefined || obj[key] === null) {
        return false;
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        log.warn(`Invalid INI key skipped: ${key}`);
        return false;
      }
      return true;
    })
    .map(([key, value]) => {
      const safeValue = String(value).replace(/[\r\n]/g, "");
      return `${key}=${safeValue}`;
    })
    .join("\n");
}

export function parseSandboxVars(content: string): JsonRecord {
  const result: JsonRecord = {
    VERSION: 4,
    settings: {},
    ZombieLore: {},
    ZombieConfig: {},
    MultiplierConfig: {},
    Map: {},
    Basement: {},
    Music: {},
    Debug: {},
  };

  const nestedBlocks = [
    "ZombieLore",
    "ZombieConfig",
    "MultiplierConfig",
    "Map",
    "Basement",
    "Music",
    "Debug",
  ];

  try {
    const versionMatch = content.match(/VERSION\s*=\s*(\d+)/);
    if (versionMatch) {
      result.VERSION = parseInt(versionMatch[1], 10);
    }

    let topLevelContent = content;
    for (const blockName of nestedBlocks) {
      const blockPattern = new RegExp(
        escapeRegExp(blockName) + "\\s*=\\s*\\{[\\s\\S]*?\\n\\s*\\}",
        "m",
      );
      topLevelContent = topLevelContent.replace(blockPattern, "");
    }

    const simplePattern =
      /^\s*(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,{}\n]+),?\s*(?:--.*)?$/gm;
    let match;
    while ((match = simplePattern.exec(topLevelContent)) !== null) {
      const key = match[1];
      let value: any = match[2].trim();

      if (nestedBlocks.includes(key) || key === "VERSION") continue;

      if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (!isNaN(parseFloat(value))) value = parseFloat(value);
      else value = unescapeLuaString(value);

    result.settings[key] = value;
    }

    function parseNestedBlock(blockName: string) {
      const blockPattern = new RegExp(
        `${blockName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
        "m",
      );
      const blockMatch = content.match(blockPattern);

      if (blockMatch) {
        const blockContent = blockMatch[1];
        const strippedContent = blockContent.replace(/^\s*--.*$/gm, "");
        const valuePattern = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\n]+)/g;
        let valueMatch;
        while ((valueMatch = valuePattern.exec(strippedContent)) !== null) {
          let value: any = valueMatch[2].trim();
          value = value.replace(/,\s*$/, "");

          if (value === "true") value = true;
          else if (value === "false") value = false;
          else if (!isNaN(parseFloat(value))) value = parseFloat(value);
          else value = unescapeLuaString(value);

          result[blockName][valueMatch[1]] = value;
        }
      }
    }

    nestedBlocks.forEach(parseNestedBlock);
  } catch (error: unknown) {
    log.error("Failed to parse SandboxVars:", error);
  }

  return result;
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

function modifySandboxValue(
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
    for (const bn of knownBlocks) {
      const bp = new RegExp(escapeRegExp(bn) + "\\s*=\\s*\\{");
      const bm = content.match(bp);
      if (bm) {
        const start = bm.index ?? -1;
        if (start < 0) continue;
        const end = content.indexOf("}", start + bm[0].length);
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

export function checkSandboxBraceBalance(content: string): { balanced: boolean; depth: number } {
  let depth = 0;
  let wentNegative = false;
  for (const ch of content) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) wentNegative = true;
    }
  }
  return { balanced: depth === 0 && !wentNegative, depth };
}

export function repairSandboxSyntax(content: string): {
  content: string;
  fixed: boolean;
  changes: string[];
} {
  const before = checkSandboxBraceBalance(content);
  if (before.balanced) {
    return { content, fixed: false, changes: [] };
  }

  const lines = content.split(/\r?\n/);
  const changes = [];
  const scalarLine =
    /^(\s*)(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)\s*(--.*)?$/;
  const entryLine = /^(\s*)(\w+)\s*=\s*/;
  let syntheticCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(scalarLine);
    if (!m) continue;
    const indent = m[1];

    let j = i + 1;
    while (
      j < lines.length &&
      (lines[j].trim() === "" || /^\s*--/.test(lines[j]))
    ) {
      j++;
    }
    if (j >= lines.length) continue;

    const nextEntry = lines[j].match(entryLine);
    if (!nextEntry) continue;
    if (nextEntry[1].length <= indent.length) continue;

    syntheticCounter += 1;
    changes.push(
      `Line ${i + 1}: '${m[2]} = ${m[3]}' looked like an orphaned block entry (missing block header and comma) — wrapped it in a synthetic '_RepairedBlock${syntheticCounter}' table so the file parses again.`,
    );
    lines[i] =
      `${indent}_RepairedBlock${syntheticCounter} = {\n${indent}    ${m[2]} = ${m[3]},`;
  }

  const repaired = lines.join("\n");
  const after = checkSandboxBraceBalance(repaired);
  return {
    content: repaired,
    fixed: after.balanced && changes.length > 0,
    changes,
  };
}

export function applySandboxChanges(
  originalContent: string,
  changes: SandboxChangeSet,
): string {
  let content = originalContent;

  if (changes.settings) {
    for (const [key, value] of Object.entries(changes.settings)) {
      content = modifySandboxValue(content, key, value, null);
    }
  }

  if (changes.ZombieLore) {
    for (const [key, value] of Object.entries(changes.ZombieLore)) {
      content = modifySandboxValue(content, key, value, "ZombieLore");
    }
  }

  if (changes.ZombieConfig) {
    for (const [key, value] of Object.entries(changes.ZombieConfig)) {
      content = modifySandboxValue(content, key, value, "ZombieConfig");
    }
  }

  if (changes.MultiplierConfig) {
    for (const [key, value] of Object.entries(changes.MultiplierConfig)) {
      content = modifySandboxValue(content, key, value, "MultiplierConfig");
    }
  }

  if (changes.Map) {
    for (const [key, value] of Object.entries(changes.Map)) {
      content = modifySandboxValue(content, key, value, "Map");
    }
  }

  if (changes.Basement) {
    for (const [key, value] of Object.entries(changes.Basement)) {
      content = modifySandboxValue(content, key, value, "Basement");
    }
  }

  return content;
}

const SANDBOX_WRITABLE_SECTIONS = [
  "settings",
  "ZombieLore",
  "ZombieConfig",
  "MultiplierConfig",
  "Map",
  "Basement",
];

export function findUnpersistedSandboxKeys(
  submitted: SandboxChangeSet,
  persisted: JsonRecord,
): string[] {
  const unpersistedKeys: string[] = [];
  for (const section of SANDBOX_WRITABLE_SECTIONS) {
    const submittedSection = submitted[section];
    if (!submittedSection || typeof submittedSection !== "object") continue;
    const persistedSection =
      section === "settings" ? persisted.settings : persisted[section];
    for (const [key, value] of Object.entries(submittedSection)) {
      if ((persistedSection || {})[key] !== value) {
        unpersistedKeys.push(section === "settings" ? key : `${section}.${key}`);
      }
    }
  }
  return unpersistedKeys;
}

function createSandboxVars(sandbox: JsonRecord): string {
  const sections = [
    "settings",
    "ZombieLore",
    "ZombieConfig",
    "MultiplierConfig",
    "Map",
    "Basement",
  ];
  const lines = ["SandboxVars = {"];
  const version = Number.isInteger(sandbox.VERSION) ? sandbox.VERSION : 4;
  lines.push(`    VERSION = ${version},`);

  const formatValue = (value: unknown): string => {
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return `"${escapeLuaString(String(value))}"`;
  };

  for (const sectionName of sections) {
    const values = sandbox[sectionName];
    if (!values || typeof values !== "object") continue;

    if (sectionName === "settings") {
      for (const [key, value] of Object.entries(values)) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          lines.push(`    ${key} = ${formatValue(value)},`);
        }
      }
      continue;
    }

    lines.push(`    ${sectionName} = {`);
    for (const [key, value] of Object.entries(values)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        lines.push(`        ${key} = ${formatValue(value)},`);
      }
    }
    lines.push("    },");
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

function parseSpawnPoints(content: string): Record<string, SpawnPoint[]> {
  const professions: Record<string, SpawnPoint[]> = {};

  try {
    const professionPattern = /(\w+)\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    let profMatch;

    while ((profMatch = professionPattern.exec(content)) !== null) {
      const profName = profMatch[1];
      const profContent = profMatch[2];

      if (profName === "return") continue;

      const points = [];
      const pointPattern =
        /\{\s*worldX\s*=\s*(\d+)\s*,\s*worldY\s*=\s*(\d+)\s*,\s*posX\s*=\s*([\d.]+)\s*,\s*posY\s*=\s*([\d.]+)(?:\s*,\s*posZ\s*=\s*(\d+))?\s*\}/g;
      let pointMatch;

      while ((pointMatch = pointPattern.exec(profContent)) !== null) {
        points.push({
          worldX: parseInt(pointMatch[1], 10),
          worldY: parseInt(pointMatch[2], 10),
          posX: parseFloat(pointMatch[3]),
          posY: parseFloat(pointMatch[4]),
          posZ: pointMatch[5] ? parseInt(pointMatch[5], 10) : 0,
        });
      }

      if (points.length > 0) {
        professions[profName] = points;
      }
    }
  } catch (error: unknown) {
    log.error("Failed to parse spawn points:", error);
  }

  return professions;
}

function toSpawnPoints(
  professions: Record<string, SpawnPoint[]>,
  serverName: string,
): string {
  const lines = [`function SpawnPoints()`];
  lines.push(`\treturn {`);

  for (const [profName, points] of Object.entries(professions)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(profName)) {
      log.warn(`Invalid profession name skipped in spawnpoints: ${profName}`);
      continue;
    }
    lines.push(`\t\t${profName} = {`);
    for (const p of points) {
      const wx = Number.isFinite(Number(p.worldX)) ? Number(p.worldX) : 0;
      const wy = Number.isFinite(Number(p.worldY)) ? Number(p.worldY) : 0;
      const px = Number.isFinite(Number(p.posX)) ? Number(p.posX) : 0;
      const py = Number.isFinite(Number(p.posY)) ? Number(p.posY) : 0;
      const pz = Number.isFinite(Number(p.posZ)) ? Number(p.posZ) : 0;
      if (pz && pz !== 0) {
        lines.push(
          `\t\t\t{ worldX = ${wx}, worldY = ${wy}, posX = ${px}, posY = ${py}, posZ = ${pz} }`,
        );
      } else {
        lines.push(
          `\t\t\t{ worldX = ${wx}, worldY = ${wy}, posX = ${px}, posY = ${py} }`,
        );
      }
    }
    lines.push(`\t\t}`);
  }

  lines.push(`\t}`);
  lines.push(`end`);
  return lines.join("\n");
}

function parseSpawnRegions(content: string): SpawnRegion[] {
  const regions: SpawnRegion[] = [];

  try {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().startsWith("--")) continue;

      const nameMatch = line.match(/name\s*=\s*"([^"]+)"/);
      const fileMatch = line.match(/(?:server)?file\s*=\s*"([^"]+)"/);

      if (nameMatch && fileMatch) {
        regions.push({
          name: nameMatch[1],
          file: fileMatch[1],
          isServerFile: line.includes("serverfile"),
        });
      }
    }
  } catch (error: unknown) {
    log.error("Failed to parse spawn regions:", error);
  }

  return regions;
}

function toSpawnRegions(regions: SpawnRegion[], serverName: string): string {
  const lines = [`function SpawnRegions()`];
  lines.push(`        return {`);

  for (const r of regions) {
    const safeName = escapeLuaString(r.name);
    const safeFile = escapeLuaString(r.file);
    if (r.isServerFile) {
      lines.push(
        `                { name = "${safeName}", serverfile = "${safeFile}" },`,
      );
    } else {
      lines.push(
        `                { name = "${safeName}", file = "${safeFile}" },`,
      );
    }
  }

  lines.push(`        }`);
  lines.push(`end`);
  return lines.join("\n");
}


router.get("/paths", async (req, res) => {
  try {
    log.info("GET /paths");
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();

    const files = {
      ini: path.join(configPath, `${serverName}.ini`),
      sandbox: path.join(configPath, `${serverName}_SandboxVars.lua`),
      spawnpoints: path.join(configPath, `${serverName}_spawnpoints.lua`),
      spawnregions: path.join(configPath, `${serverName}_spawnregions.lua`),
    };

    const exists = {
      ini: fs.existsSync(files.ini),
      sandbox: fs.existsSync(files.sandbox),
      spawnpoints: fs.existsSync(files.spawnpoints),
      spawnregions: fs.existsSync(files.spawnregions),
    };

    res.json({ configPath, serverName, files, exists });
  } catch (error: unknown) {
    log.error("Failed to get paths:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/ini", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}.ini`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "INI file not found",
        code: ErrorCode.INI_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseIni(content);

    const duplicateKeys = findDuplicateIniKeys(content);

    res.json({
      settings: maskSensitiveObject(parsed),
      path: filePath,
      serverName,
      duplicateKeys,
    });
  } catch (error: unknown) {
    log.error("Failed to read INI:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/ini", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    log.info(
      `PUT /ini: serverName=${serverName}, keys=${Object.keys(body.settings || {}).length}`,
    );
    const filePath = path.join(configPath, `${serverName}.ini`);
    const { settings } = body;

    if (!settings || typeof settings !== "object") {
      return res.status(400).json({
        error: "Settings object required",
        code: ErrorCode.INI_SETTINGS_REQUIRED,
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(settings, "__proto__") ||
      Object.prototype.hasOwnProperty.call(settings, "constructor") ||
      Object.prototype.hasOwnProperty.call(settings, "prototype")
    ) {
      return res.status(400).json({
        error: "Invalid settings",
        code: ErrorCode.INI_SETTINGS_INVALID,
      });
    }

    const currentIniContent = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf-8")
      : "";
    const duplicateKeysOnDisk = findDuplicateIniKeys(currentIniContent);
    if (duplicateKeysOnDisk.length > 0) {
      return res.status(409).json({
        error:
          "This file has a key duplicated across two config blocks. Saving from the structured editor would permanently discard one copy's value. Use the raw editor tab to fix the duplicate first.",
        duplicateKeys: duplicateKeysOnDisk,
        code: ErrorCode.INI_DUPLICATE_KEY_BLOCKS_STRUCTURED_SAVE,
      });
    }

    const submittedSettings: JsonRecord = {};
    for (const [key, value] of Object.entries(settings)) {
      if (SENSITIVE_FIELD_RE.test(key) && isMaskedSecret(value)) {
        log.info(`Preserving stored value for sensitive key "${key}" (masked input ignored)`);
        continue;
      }
      submittedSettings[key] = value;
    }

    const touchesGovernedIniKey = Object.keys(submittedSettings).some(
      (key) => key in INI_KEY_CAPABILITY,
    );
    if (touchesGovernedIniKey) {
      const currentIni = parseIni(currentIniContent);
      const missingCapabilities = [];
      let callerCapabilities = null;
      for (const [key, value] of Object.entries(submittedSettings)) {
        const requiredCapability = INI_KEY_CAPABILITY[key];
        if (!requiredCapability) continue;
        if (String(currentIni[key] ?? "") === String(value ?? "")) continue;
        if (callerCapabilities === null) {
          const role = req.user ? await getRoleByName(req.user.role ?? "") : null;
          callerCapabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
        }
        if (!callerCapabilities.includes(requiredCapability)) {
          missingCapabilities.push({ key, requiredCapability });
        }
      }
      if (missingCapabilities.length > 0) {
        const detail = missingCapabilities
          .map((m) => `"${m.key}" needs ${m.requiredCapability}`)
          .join(", ");
        return res.status(403).json({
          error: `Cannot change ${detail} without holding that capability yourself.`,
          missing: missingCapabilities,
        });
      }
    }

    let backupWarning = null;
    const persistedSettings = await withFileLock(filePath, async () => {
      let originalContent = "";
      if (fs.existsSync(filePath)) {
        originalContent = fs.readFileSync(filePath, "utf-8");
        backupWarning = backupWarningFor(await createBackup(configPath, `${serverName}.ini`));
      }

      const content = toIni(submittedSettings, originalContent);
      writeFileAtomic(filePath, content, "utf-8");
      const persisted = parseIni(fs.readFileSync(filePath, "utf-8"));
      const original = parseIni(originalContent);
      for (const [key, value] of Object.entries(submittedSettings)) {
        const isExistingKey = Object.prototype.hasOwnProperty.call(original, key);
        const isNewNonEmptyKey = value !== "" && value !== null && value !== undefined;
        if ((isExistingKey || isNewNonEmptyKey) && persisted[key] !== String(value).replace(/[\r\n]/g, "")) {
          throw new Error(`INI write verification failed for ${key}`);
        }
      }
      return persisted;
    });

    log.info("Saved INI file");
    res.json({
      success: true,
      message: "Settings saved",
      path: filePath,
      settings: maskSensitiveObject(persistedSettings),
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error: unknown) {
    log.error("Failed to save INI:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/sandbox", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "SandboxVars file not found",
        code: ErrorCode.SANDBOXVARS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseSandboxVars(content);

    res.json({ sandbox: parsed, path: filePath, serverName });
  } catch (error: unknown) {
    log.error("Failed to read SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/sandbox", async (req, res) => {
  try {
    log.info("PUT /sandbox");
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);
    const { sandbox } = req.body || {};

    if (!sandbox || typeof sandbox !== "object") {
      return res.status(400).json({
        error: "Sandbox object required",
        code: ErrorCode.SANDBOX_OBJECT_REQUIRED,
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(sandbox, "__proto__") ||
      Object.prototype.hasOwnProperty.call(sandbox, "constructor") ||
      Object.prototype.hasOwnProperty.call(sandbox, "prototype")
    ) {
      return res.status(400).json({
        error: "Invalid sandbox data",
        code: ErrorCode.SANDBOX_DATA_INVALID,
      });
    }

    for (const section of Object.values(sandbox)) {
      if (section && typeof section === "object") {
        if (
          Object.prototype.hasOwnProperty.call(section, "__proto__") ||
          Object.prototype.hasOwnProperty.call(section, "constructor") ||
          Object.prototype.hasOwnProperty.call(section, "prototype")
        ) {
          return res.status(400).json({
            error: "Invalid sandbox data",
            code: ErrorCode.SANDBOX_DATA_INVALID,
          });
        }
      }
    }

    const payloadSize = JSON.stringify(sandbox).length;
    if (payloadSize > 1024 * 1024) {
      return res.status(400).json({
        error: "Sandbox data too large (max 1MB)",
        code: ErrorCode.SANDBOX_DATA_TOO_LARGE,
      });
    }

    let backupWarning = null;
    let fileExists = false;
    let unpersistedKeys: string[] = [];
    await withFileLock(filePath, async () => {
      fileExists = fs.existsSync(filePath);
      const newContent = fileExists
        ? applySandboxChanges(fs.readFileSync(filePath, "utf-8"), sandbox)
        : createSandboxVars(sandbox);
      if (fileExists) {
        backupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}_SandboxVars.lua`),
        );
      }
      writeFileAtomic(filePath, newContent, "utf-8");

      const persisted = parseSandboxVars(fs.readFileSync(filePath, "utf-8"));
      unpersistedKeys = findUnpersistedSandboxKeys(sandbox, persisted);
    });

    if (unpersistedKeys.length > 0) {
      log.warn(
        `SandboxVars keys did not persist (no matching entry found to update): ${unpersistedKeys.join(", ")}`,
      );
    }
    log.info(`${fileExists ? "Saved" : "Created"} SandboxVars file`);
    res.json({
      success: true,
      created: !fileExists,
      message: fileExists ? "Sandbox settings saved" : "SandboxVars file created",
      path: filePath,
      ...(unpersistedKeys.length > 0 ? { unpersistedKeys } : {}),
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error: unknown) {
    log.error("Failed to save SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/sandbox-option", async (req, res) => {
  try {
    const { name, value } = req.body || {};

    if (typeof name !== "string" || !name) {
      return res.status(400).json({
        error: "Option name required",
        code: ErrorCode.SANDBOX_OPTION_NAME_REQUIRED,
      });
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return res.status(400).json({
        error: "Option value must be a primitive",
        code: ErrorCode.SANDBOX_OPTION_VALUE_INVALID,
      });
    }

    const parts = name.split(".");
    const isIdentifier = (p: string): boolean => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p);
    if (parts.length > 2 || !parts.every(isIdentifier)) {
      return res.status(400).json({
        error: "Invalid option name",
        code: ErrorCode.SANDBOX_OPTION_NAME_INVALID,
      });
    }
    const block = parts.length === 2 ? parts[0] : null;
    const key = parts.length === 2 ? parts[1] : parts[0];

    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error:
          "SandboxVars file not found. Start the server once to generate it.",
        code: ErrorCode.SANDBOX_OPTION_FILE_NOT_FOUND,
      });
    }

    let persisted = false;
    let backupWarning = null;
    await withFileLock(filePath, async () => {
      const originalContent = fs.readFileSync(filePath, "utf-8");
      const newContent = modifySandboxValue(originalContent, key, value, block);
      if (newContent === originalContent) return;
      backupWarning = backupWarningFor(
        await createBackup(configPath, `${serverName}_SandboxVars.lua`),
      );
      writeFileAtomic(filePath, newContent, "utf-8");
      persisted = true;
    });

    log.info(`Sandbox option ${name} persisted: ${persisted}`);
    res.json({
      success: true,
      persisted,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error: unknown) {
    log.error("Failed to save sandbox option:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

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

router.get("/sandbox/validate", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "SandboxVars file not found",
        code: ErrorCode.SANDBOXVARS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const { balanced, depth } = checkSandboxBraceBalance(content);
    res.json({ valid: balanced, braceDepth: depth });
  } catch (error: unknown) {
    log.error("Failed to validate SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/sandbox/repair", async (req, res) => {
  try {
    log.info("POST /sandbox/repair");
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "SandboxVars file not found",
        code: ErrorCode.SANDBOXVARS_FILE_NOT_FOUND,
      });
    }

    const result: SandboxRepairResult = await withFileLock(filePath, async () => {
      const originalContent = fs.readFileSync(filePath, "utf-8");
      const before = checkSandboxBraceBalance(originalContent);
      if (before.balanced) {
        return { alreadyValid: true };
      }

      const {
        content: repaired,
        fixed,
        changes,
      } = repairSandboxSyntax(originalContent);
      if (!fixed) {
        return {
          alreadyValid: false,
          repaired: false,
          error:
            "Could not automatically repair this file — the corruption doesn't match a known pattern. Restore from a backup or fix it manually.",
          code: ErrorCode.SANDBOX_REPAIR_PATTERN_UNKNOWN,
        };
      }

      const backup = await createBackup(configPath, `${serverName}_SandboxVars.lua`);
      if (!backup.backedUp) {
        return {
          alreadyValid: false,
          repaired: false,
          error:
            `Could not back up SandboxVars.lua before repairing it, so nothing was changed: ${backup.error}. ` +
            "Free up disk space or fix the backups folder's permissions, or copy the file aside yourself, then try again.",
          code: ErrorCode.SANDBOX_REPAIR_BACKUP_FAILED,
          params: { reason: backup.error },
        };
      }

      writeFileAtomic(filePath, repaired, "utf-8");
      return { alreadyValid: false, repaired: true, changes, backupName: backup.name };
    });

    if (result.alreadyValid) {
      return res.json({
        success: true,
        alreadyValid: true,
        message: "SandboxVars.lua is already valid — no repair needed.",
      });
    }
    if (!result.repaired) {
      const body: JsonRecord = { success: false, error: result.error, code: result.code };
      if (result.params) body.params = sanitizeErrorParams(result.params);
      return res.status(422).json(body);
    }

    log.info(
      `Repaired SandboxVars.lua: ${result.changes.length} fix(es) applied`,
    );
    res.json({
      success: true,
      repaired: true,
      changes: result.changes,
      message: `Repaired ${result.changes.length} issue${result.changes.length === 1 ? "" : "s"} in SandboxVars.lua. A backup of the broken file was saved first (${result.backupName}).`,
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error: unknown) {
    log.error("Failed to repair SandboxVars:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/spawnpoints", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_spawnpoints.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "Spawn points file not found",
        path: filePath,
        code: ErrorCode.SPAWNPOINTS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const points = parseSpawnPoints(content);

    res.json({ spawnpoints: points, path: filePath });
  } catch (error: unknown) {
    log.error("Failed to read spawn points:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/spawnpoints", async (req, res) => {
  try {
    log.info("PUT /spawnpoints");
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_spawnpoints.lua`);
    const { spawnpoints } = req.body || {};

    if (!spawnpoints || typeof spawnpoints !== "object") {
      return res.status(400).json({
        error: "Spawn points object required (keyed by profession)",
        code: ErrorCode.SPAWNPOINTS_OBJECT_REQUIRED,
      });
    }

    let backupWarning = null;
    await withFileLock(filePath, async () => {
      if (fs.existsSync(filePath)) {
        backupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}_spawnpoints.lua`),
        );
      }

      const newContent = toSpawnPoints(spawnpoints, serverName);
      writeFileAtomic(filePath, newContent, "utf-8");
    });

    log.info("Saved spawn points file");
    res.json({
      success: true,
      message: "Spawn points saved",
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error: unknown) {
    log.error("Failed to save spawn points:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/spawnregions", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_spawnregions.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "Spawn regions file not found",
        path: filePath,
        code: ErrorCode.SPAWNREGIONS_FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const regions = parseSpawnRegions(content);

    res.json({ spawnregions: regions, path: filePath });
  } catch (error: unknown) {
    log.error("Failed to read spawn regions:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/spawnregions", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const filePath = path.join(configPath, `${serverName}_spawnregions.lua`);
    const { spawnregions } = req.body || {};

    if (!Array.isArray(spawnregions)) {
      return res.status(400).json({
        error: "Spawn regions array required",
        code: ErrorCode.SPAWNREGIONS_ARRAY_REQUIRED,
      });
    }

    let backupWarning = null;
    await withFileLock(filePath, async () => {
      if (fs.existsSync(filePath)) {
        backupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}_spawnregions.lua`),
        );
      }

      const newContent = toSpawnRegions(spawnregions, serverName);
      writeFileAtomic(filePath, newContent, "utf-8");
    });

    log.info("Saved spawn regions file");
    res.json({
      success: true,
      message: "Spawn regions saved",
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error: unknown) {
    log.error("Failed to save spawn regions:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/raw/:type", async (req, res) => {
  log.info(`GET /raw/${req.params.type}`);
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const type = req.params.type;

    const fileMap: Record<string, string> = {
      ini: `${serverName}.ini`,
      sandbox: `${serverName}_SandboxVars.lua`,
      spawnpoints: `${serverName}_spawnpoints.lua`,
      spawnregions: `${serverName}_spawnregions.lua`,
    };

    if (!fileMap[type]) {
      return res.status(400).json({
        error: "Invalid file type",
        code: ErrorCode.RAW_FILE_INVALID_TYPE,
      });
    }

    const filePath = path.join(configPath, fileMap[type]);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "File not found",
        code: ErrorCode.FILE_NOT_FOUND,
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    res.json({
      content: type === "ini" ? maskSensitiveIniLines(content) : content,
      filename: fileMap[type],
    });
  } catch (error: unknown) {
    log.error("Failed to read raw file:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/raw/:type", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();
    const type = req.params.type;
    const { content } = req.body || {};
    log.info(`PUT /raw/${type}: contentLength=${content?.length || 0}`);

    const fileMap: Record<string, string> = {
      ini: `${serverName}.ini`,
      sandbox: `${serverName}_SandboxVars.lua`,
      spawnpoints: `${serverName}_spawnpoints.lua`,
      spawnregions: `${serverName}_spawnregions.lua`,
    };

    if (!fileMap[type]) {
      return res.status(400).json({
        error: "Invalid file type",
        code: ErrorCode.RAW_FILE_INVALID_TYPE,
      });
    }

    if (typeof content !== "string") {
      return res.status(400).json({
        error: "Content string required",
        code: ErrorCode.RAW_CONTENT_STRING_REQUIRED,
      });
    }

    if (content.length > 512 * 1024) {
      return res.status(400).json({
        error: "Content too large (max 512KB)",
        code: ErrorCode.RAW_CONTENT_TOO_LARGE,
      });
    }

    const filePath = path.join(configPath, fileMap[type]);

    let backupWarning = null;
    const reconcileFailure = { value: null as MaskedIniResult | null };
    await withFileLock(filePath, async () => {
      let contentToWrite = content;

      if (type === "ini" && fs.existsSync(filePath)) {
        const liveContent = fs.readFileSync(filePath, "utf-8");
        const reconciled = reconcileMaskedIniLines(content, liveContent);
        if (!reconciled.ok) {
          reconcileFailure.value = reconciled;
          return;
        }
        contentToWrite = reconciled.content;
      }

      if (type === "ini") {
        backupWarning = backupWarningFor(await writeIniWithBackup(filePath, contentToWrite));
      } else {
        if (fs.existsSync(filePath)) {
          backupWarning = backupWarningFor(await createBackup(configPath, fileMap[type]));
        }
        writeFileAtomic(filePath, contentToWrite, "utf-8");
      }
    });

    if (reconcileFailure.value && !reconcileFailure.value.ok) {
      const failure = reconcileFailure.value;
      const isRemoved = failure.reason === "removed";
      return res.status(400).json({
        error: isRemoved
          ? `The "${failure.key}" line was removed, but it holds a live secret that can't be silently dropped. To clear it, write "${failure.key}=" explicitly instead of deleting the line, or use the structured editor.`
          : `Could not safely save: the "${failure.key}" line's masked value could not be matched back to exactly one live value. Nothing was written.`,
        code: isRemoved
          ? ErrorCode.RAW_INI_SECRET_LINE_REMOVED
          : ErrorCode.RAW_INI_SECRET_UNRESOLVABLE,
        params: sanitizeErrorParams({ key: failure.key }),
      });
    }

    log.info(`Saved raw file: ${fileMap[type]}`);
    res.json({
      success: true,
      message: "File saved",
      ...(backupWarning ? { backupWarning } : {}),
      ...(req.configEditRestartWarning ? { restartRequired: true } : {}),
    });
  } catch (error: unknown) {
    log.error("Failed to save raw file:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/backups", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const backupDir = await getBackupPath(configPath);

    if (!fs.existsSync(backupDir)) {
      return res.json({ backups: [] });
    }

    const fileList = await fs.promises.readdir(backupDir);
    const files: any[] = (
      await Promise.all(
        fileList
          .filter((f) => f.endsWith(".bak"))
          .map(async (filename) => {
            try {
              const stats = await fs.promises.stat(
                path.join(backupDir, filename),
              );
              return {
                filename,
                size: stats.size,
                created: stats.birthtime,
              };
            } catch (e: unknown) {
              log.debug(
                `Stat failed for backup file ${filename}: ${errorMessage(e)}`,
              );
              return null;
            }
          }),
      )
    )
      .filter((f) => f !== null)
      .sort((a, b) => {
        const dateA = new Date(a.created);
        const dateB = new Date(b.created);
        if (isNaN(dateA.getTime())) return 1;
        if (isNaN(dateB.getTime())) return -1;
        return dateB.getTime() - dateA.getTime();
      });

    res.json({ backups: files, path: backupDir });
  } catch (error: unknown) {
    log.error("Failed to list backups:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/restore/:filename", async (req, res) => {
  try {
    const configPath = await getServerConfigPath();
    const backupDir = await getBackupPath(configPath);

    const filename = path.basename(req.params.filename);
    log.info(`POST /restore: filename=${filename}`);

    if (!filename.endsWith(".bak")) {
      return res.status(400).json({
        error: "Invalid backup file extension",
        code: ErrorCode.RESTORE_INVALID_EXTENSION,
      });
    }

    const backupPath = path.join(backupDir, filename);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({
        error: "Backup not found",
        code: ErrorCode.RESTORE_BACKUP_NOT_FOUND,
      });
    }

    const parts = filename.split(".");
    if (parts.length < 3) {
      return res.status(400).json({
        error: "Invalid backup filename",
        code: ErrorCode.RESTORE_INVALID_FILENAME,
      });
    }

    const bakIndex = filename.lastIndexOf(".bak");
    const timestampStart = filename.lastIndexOf(".", bakIndex - 1);
    const originalName = filename.substring(0, timestampStart);

    if (
      !originalName ||
      originalName === "." ||
      originalName === ".." ||
      originalName.includes("/") ||
      originalName.includes("\\")
    ) {
      return res.status(400).json({
        error: "Invalid backup filename",
        code: ErrorCode.RESTORE_INVALID_ORIGINAL_NAME,
      });
    }

    const targetPath = path.join(configPath, originalName);

    let preRestoreBackupWarning = null;
    if (fs.existsSync(targetPath)) {
      const backup = await createBackup(configPath, originalName);
      if (!backup.backedUp && backup.reason !== "no-source") {
        preRestoreBackupWarning = `Could not back up the current ${originalName} before restoring over it: ${backup.error}. The version that was in place before this restore is not recoverable through this panel.`;
      }
    }

    await fs.promises.copyFile(backupPath, targetPath);

    log.info(`Restored from backup: ${filename} -> ${originalName}`);
    res.json({
      success: true,
      message: `Restored ${originalName} from backup`,
      ...(preRestoreBackupWarning ? { backupWarning: preRestoreBackupWarning } : {}),
    });
  } catch (error: unknown) {
    log.error("Failed to restore backup:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/save-and-reload", async (req, res) => {
  try {
    log.info("POST /save-and-reload");
    const rconService = req.app.get("rconService");

    if (!rconService || !rconService.isConnected()) {
      return res.status(400).json({
        error: "RCON not connected. Changes saved but not reloaded.",
        code: ErrorCode.SAVE_AND_RELOAD_RCON_NOT_CONNECTED,
      });
    }

    const result = await rconService.reloadOptions();
    if (!result?.success) {
      return res.json({
        success: false,
        error: result?.error || "Failed to reload options via RCON",
        result,
      });
    }
    res.json({ success: true, message: "Options reloaded", result });
  } catch (error: unknown) {
    log.error("Failed to reload options:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});


async function getTemplatesPath() {
  const configPath = await getServerConfigPath();
  return path.join(configPath, "templates");
}

async function ensureTemplatesDir() {
  const templatesPath = await getTemplatesPath();
  if (!fs.existsSync(templatesPath)) {
    fs.mkdirSync(templatesPath, { recursive: true });
  }
  return templatesPath;
}

router.get("/templates", async (req, res) => {
  try {
    const templatesPath = await ensureTemplatesDir();

    const files: any[] = fs
      .readdirSync(templatesPath)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const filePath = path.join(templatesPath, f);
          const stats = fs.statSync(filePath);
          const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          return {
            id: f.replace(".json", ""),
            name: content.name || f.replace(".json", ""),
            description: content.description || "",
            type: content.type || "both", // 'ini', 'sandbox', or 'both'
            created: content.created || stats.birthtime.toISOString(),
            modified: stats.mtime.toISOString(),
            hasIni: !!content.ini,
            hasSandbox: !!content.sandbox,
          };
        } catch (e: unknown) {
          log.debug(`Template read failed for ${f}: ${errorMessage(e)}`);
          return null;
        }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    res.json({ templates: files });
  } catch (error: unknown) {
    log.error("Failed to list templates:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/templates/:id", async (req, res) => {
  try {
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({
        error: "Invalid template ID",
        code: ErrorCode.TEMPLATE_ID_INVALID,
      });
    }

    const templatesPath = await getTemplatesPath();
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    const content = JSON.parse(fs.readFileSync(templateFile, "utf-8"));
    res.json(content);
  } catch (error: unknown) {
    log.error("Failed to get template:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/templates", async (req, res) => {
  log.info("POST /templates (create)");
  try {
    const {
      name,
      description,
      includeIni = true,
      includeSandbox = true,
    } = req.body;

    if (!name) {
      return res.status(400).json({
        error: "Template name is required",
        code: ErrorCode.TEMPLATE_NAME_REQUIRED,
      });
    }

    const templatesPath = await ensureTemplatesDir();
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();

    const baseId = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .substring(0, 50);
    let safeId = baseId;
    let counter = 1;
    while (fs.existsSync(path.join(templatesPath, `${safeId}.json`))) {
      safeId = `${baseId}_${counter++}`;
      if (counter > 100) {
        return res.status(400).json({
          error: "Too many templates with similar names",
          code: ErrorCode.TEMPLATE_NAME_CONFLICT_LIMIT,
        });
      }
    }
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    const template: JsonRecord = {
      name,
      description: description || "",
      type:
        includeIni && includeSandbox ? "both" : includeIni ? "ini" : "sandbox",
      created: new Date().toISOString(),
      serverName,
    };

    if (includeIni) {
      const iniPath = path.join(configPath, `${serverName}.ini`);
      if (fs.existsSync(iniPath)) {
        const iniContent = fs.readFileSync(iniPath, "utf-8");
        template.ini = omitSensitiveFields(parseIni(iniContent));
        template.iniRaw = stripSensitiveIniLines(iniContent);
      }
    }

    if (includeSandbox) {
      const sandboxPath = path.join(
        configPath,
        `${serverName}_SandboxVars.lua`,
      );
      if (fs.existsSync(sandboxPath)) {
        template.sandboxRaw = fs.readFileSync(sandboxPath, "utf-8");
      }
    }

    fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));
    log.info(`Created template: ${name} (${safeId})`);

    res.json({
      success: true,
      id: safeId,
      name,
      message: `Template "${name}" saved successfully`,
    });
  } catch (error: unknown) {
    log.error("Failed to save template:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/templates/:id/apply", async (req, res) => {
  log.info(`POST /templates/${req.params.id}/apply`);
  const applied = [];
  try {
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({
        error: "Invalid template ID",
        code: ErrorCode.TEMPLATE_ID_INVALID,
      });
    }

    const { applyIni = true, applySandbox = true } = req.body || {};

    const templatesPath = await getTemplatesPath();
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    const template = JSON.parse(fs.readFileSync(templateFile, "utf-8"));
    const configPath = await getServerConfigPath();
    const serverName = await getServerName();

    const backupWarnings: string[] = [];

    if (applyIni && template.iniRaw) {
      const iniPath = path.join(configPath, `${serverName}.ini`);

      await withFileLock(iniPath, async () => {
        const iniBackupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}.ini`),
        );
        if (iniBackupWarning) backupWarnings.push(iniBackupWarning);

        writeFileAtomic(iniPath, template.iniRaw);
      });
      applied.push("INI");
      log.info(`Applied INI from template: ${template.name}`);
    }

    if (applySandbox && template.sandboxRaw) {
      const sandboxPath = path.join(
        configPath,
        `${serverName}_SandboxVars.lua`,
      );

      await withFileLock(sandboxPath, async () => {
        const sandboxBackupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}_SandboxVars.lua`),
        );
        if (sandboxBackupWarning) backupWarnings.push(sandboxBackupWarning);

        writeFileAtomic(sandboxPath, template.sandboxRaw);
      });
      applied.push("Sandbox");
      log.info(`Applied Sandbox from template: ${template.name}`);
    }

    if (applied.length === 0) {
      return res.status(400).json({
        error: "No settings to apply from this template",
        code: ErrorCode.TEMPLATE_APPLY_NOTHING_TO_APPLY,
      });
    }

    res.json({
      success: true,
      applied,
      message: `Applied ${applied.join(" and ")} settings from "${template.name}"`,
      ...(backupWarnings.length > 0 ? { backupWarnings } : {}),
    });
  } catch (error: unknown) {
    log.error("Failed to apply template:", error);
    res.status(500).json({
      error: sanitizeError(errorMessage(error)),
      ...(applied.length > 0 ? { success: false, partiallyApplied: applied } : {}),
    });
  }
});

router.put("/templates/:id", async (req, res) => {
  try {
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({
        error: "Invalid template ID",
        code: ErrorCode.TEMPLATE_ID_INVALID,
      });
    }

    const { name, description } = req.body || {};

    const templatesPath = await getTemplatesPath();
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    const template = JSON.parse(fs.readFileSync(templateFile, "utf-8"));

    if (name) template.name = name;
    if (description !== undefined) template.description = description;
    template.modified = new Date().toISOString();

    fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));

    res.json({ success: true, message: "Template updated" });
  } catch (error: unknown) {
    log.error("Failed to update template:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.delete("/templates/:id", async (req, res) => {
  log.info(`DELETE /templates/${req.params.id}`);
  try {
    const safeId = path.basename(req.params.id).replace(/[^a-z0-9_-]/gi, "");
    if (!safeId || safeId !== req.params.id) {
      return res.status(400).json({
        error: "Invalid template ID",
        code: ErrorCode.TEMPLATE_ID_INVALID,
      });
    }

    const templatesPath = await getTemplatesPath();
    const templateFile = path.join(templatesPath, `${safeId}.json`);

    if (!fs.existsSync(templateFile)) {
      return res.status(404).json({
        error: "Template not found",
        code: ErrorCode.TEMPLATE_NOT_FOUND,
      });
    }

    fs.unlinkSync(templateFile);
    log.info(`Deleted template: ${req.params.id}`);

    res.json({ success: true, message: "Template deleted" });
  } catch (error: unknown) {
    log.error("Failed to delete template:", error);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});


const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
]);

async function getAllowedBrowseRoots() {
  const roots = [];
  const activeServer = await getActiveServer();
  if (activeServer?.serverConfigPath)
    roots.push(path.resolve(activeServer.serverConfigPath));
  if (activeServer?.zomboidDataPath)
    roots.push(path.resolve(activeServer.zomboidDataPath));
  if (activeServer?.serverPath)
    roots.push(path.resolve(activeServer.serverPath));
  const settings = await getAllSettings();
  if (settings.serverConfigPath)
    roots.push(path.resolve(settings.serverConfigPath));
  if (settings.zomboidDataPath)
    roots.push(path.resolve(settings.zomboidDataPath));
  const defaultConfig = path.join(os.homedir(), "Zomboid");
  roots.push(path.resolve(defaultConfig));
  return [...new Set(roots)];
}

router.get("/browse-files", async (req, res) => {
  try {
    const browsePath = req.query.path ? String(req.query.path) : null;
    const filterExts = req.query.extensions
      ? String(req.query.extensions)
          .split(",")
          .map((e) => e.toLowerCase().trim())
      : null;

    const allowedRoots = await getAllowedBrowseRoots();
    let targetPath;
    if (browsePath) {
      targetPath = confineToRoots(browsePath, allowedRoots);
      if (!targetPath) {
        return res.status(403).json({
          error: "Access denied: path is outside allowed server directories",
          code: ErrorCode.BROWSE_ACCESS_DENIED,
        });
      }
    } else {
      const configPath = await getServerConfigPath();
      targetPath = configPath || "";
    }

    if (!targetPath) {
      return res.status(400).json({
        error: "No path provided and server config path not set",
        code: ErrorCode.BROWSE_NO_PATH,
      });
    }

    if (!fs.existsSync(targetPath)) {
      return res.status(400).json({
        error: "Path does not exist",
        code: ErrorCode.BROWSE_PATH_NOT_FOUND,
      });
    }

    const stat = await fs.promises.stat(targetPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({
        error: "Path is not a directory",
        code: ErrorCode.BROWSE_PATH_NOT_DIRECTORY,
      });
    }

    const entries = await fs.promises.readdir(targetPath, {
      withFileTypes: true,
    });

    const directories = [];
    const files = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          directories.push(entry.name);
        }
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (filterExts) {
          if (filterExts.includes(ext)) {
            files.push({ name: entry.name, ext });
          }
        } else {
          if (IMAGE_EXTENSIONS.has(ext)) {
            files.push({ name: entry.name, ext });
          }
        }
      }
    }

    directories.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    res.json({
      currentPath: targetPath,
      parent:
        path.dirname(targetPath) !== targetPath &&
        confineToRoots(path.dirname(targetPath), allowedRoots)
          ? path.dirname(targetPath)
          : null,
      directories,
      files,
    });
  } catch (error: unknown) {
    log.error(`Failed to browse files: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/image-preview", async (req, res) => {
  try {
    const filePath = req.query.path ? String(req.query.path) : null;
    if (!filePath) {
      return res.status(400).json({
        error: "Path is required",
        code: ErrorCode.IMAGE_PREVIEW_PATH_REQUIRED,
      });
    }

    const allowedRoots = await getAllowedBrowseRoots();
    const resolved = confineToRoots(filePath, allowedRoots);
    if (!resolved) {
      return res.status(403).json({
        error: "Access denied: path is outside allowed server directories",
        code: ErrorCode.BROWSE_ACCESS_DENIED,
      });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({
        error: "File not found",
        code: ErrorCode.FILE_NOT_FOUND,
      });
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return res.status(400).json({
        error: "Not an image file",
        code: ErrorCode.IMAGE_PREVIEW_NOT_IMAGE,
      });
    }

    const stat = await fs.promises.stat(resolved);
    if (stat.size > 5 * 1024 * 1024) {
      return res.status(400).json({
        error: "Image file exceeds 5MB limit",
        code: ErrorCode.IMAGE_PREVIEW_TOO_LARGE,
      });
    }

    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".webp": "image/webp",
    };
    const contentType = mimeMap[ext] || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    const previewStream = fs.createReadStream(resolved);
    previewStream.on("error", (err) => {
      log.error(`Image preview stream error: ${errorMessage(err)}`);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    previewStream.pipe(res);
  } catch (error: unknown) {
    log.error(`Failed to serve image preview: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

export default router;
