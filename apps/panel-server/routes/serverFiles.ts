import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "../http/startApiRouter.ts";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("API:Files");
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
import {
  requireStoppedForLocalConfigMutation,
  warnRunningForLocalConfigEdit,
} from "../services/configMutationGuard.ts";
import {
  escapeLuaString,
  getActiveServerContext,
  getServerConfigPath,
  getServerName,
  modifySandboxValue,
  type ActiveServerContext,
  ServerNotConfiguredError,
} from "../services/sandboxPersistence.ts";
import { ErrorCode } from "../utils/errorCodes.ts";

export {
  escapeLuaString,
  getServerConfigPath,
  getServerName,
  ServerNotConfiguredError,
} from "../services/sandboxPersistence.ts";

const router = Router();

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
  | {
      alreadyValid: false;
      repaired: false;
      error: string;
      code: string;
      params?: JsonRecord;
    }
  | {
      alreadyValid: false;
      repaired: true;
      changes: string[];
      backupName?: string;
    };
type ServerFilesRequest = Request & {
  configEditRestartWarning?: boolean;
  activeServerContext?: ActiveServerContext;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
async function getRequestServerContext(
  req: ServerFilesRequest,
): Promise<ActiveServerContext> {
  if (!req.activeServerContext) {
    req.activeServerContext = await getActiveServerContext();
  }
  return req.activeServerContext;
}

async function getRequestServerConfigPath(
  req: ServerFilesRequest,
): Promise<string> {
  const context = await getRequestServerContext(req);
  if (context.serverConfigPath) return context.serverConfigPath;
  throw context.configurationError ?? new ServerNotConfiguredError();
}

async function getRequestServerValues(req: ServerFilesRequest) {
  const context = await getRequestServerContext(req);
  const serverName =
    context.serverName ?? (await getServerName(context.activeServer));
  context.serverName = serverName;
  return { configPath: await getRequestServerConfigPath(req), serverName };
}

router.use(
  async (req: ServerFilesRequest, res: Response, next: NextFunction) => {
    try {
      const context = await getActiveServerContext();
      if (context.configurationError) throw context.configurationError;
      req.activeServerContext = context;
    } catch (err: unknown) {
      if (err instanceof ServerNotConfiguredError) {
        return res
          .status(404)
          .json({ error: errorMessage(err), code: err.code });
      }
      return next(err);
    }
    next();
  },
);

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

export function unescapeLuaString(value: unknown): string {
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
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
        return;
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
    const maskedEntries = entries.filter((e: { value: string }) =>
      isMaskedSecret(e.value),
    );
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

export function checkSandboxBraceBalance(content: string): {
  balanced: boolean;
  depth: number;
} {
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
        unpersistedKeys.push(
          section === "settings" ? key : `${section}.${key}`,
        );
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
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
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
    const { configPath, serverName } = await getRequestServerValues(req);

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
    const { configPath, serverName } = await getRequestServerValues(req);
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
    const { configPath, serverName } = await getRequestServerValues(req);
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
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
        log.info(
          `Preserving stored value for sensitive key "${key}" (masked input ignored)`,
        );
        continue;
      }
      submittedSettings[key] = value;
    }

    let backupWarning = null;
    const persistedSettings = await withFileLock(filePath, async () => {
      let originalContent = "";
      if (fs.existsSync(filePath)) {
        originalContent = fs.readFileSync(filePath, "utf-8");
        backupWarning = backupWarningFor(
          await createBackup(configPath, `${serverName}.ini`),
        );
      }

      const content = toIni(submittedSettings, originalContent);
      writeFileAtomic(filePath, content, "utf-8");
      const persisted = parseIni(fs.readFileSync(filePath, "utf-8"));
      const original = parseIni(originalContent);
      for (const [key, value] of Object.entries(submittedSettings)) {
        const isExistingKey = Object.prototype.hasOwnProperty.call(
          original,
          key,
        );
        const isNewNonEmptyKey =
          value !== "" && value !== null && value !== undefined;
        if (
          (isExistingKey || isNewNonEmptyKey) &&
          persisted[key] !== String(value).replace(/[\r\n]/g, "")
        ) {
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
    const { configPath, serverName } = await getRequestServerValues(req);
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
    const { configPath, serverName } = await getRequestServerValues(req);
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
      message: fileExists
        ? "Sandbox settings saved"
        : "SandboxVars file created",
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
    const isIdentifier = (p: string): boolean =>
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p);
    if (parts.length > 2 || !parts.every(isIdentifier)) {
      return res.status(400).json({
        error: "Invalid option name",
        code: ErrorCode.SANDBOX_OPTION_NAME_INVALID,
      });
    }
    const block = parts.length === 2 ? parts[0] : null;
    const key = parts.length === 2 ? parts[1] : parts[0];

    const { configPath, serverName } = await getRequestServerValues(req);
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

router.get("/sandbox/validate", async (req, res) => {
  try {
    const { configPath, serverName } = await getRequestServerValues(req);
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
    const { configPath, serverName } = await getRequestServerValues(req);
    const filePath = path.join(configPath, `${serverName}_SandboxVars.lua`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "SandboxVars file not found",
        code: ErrorCode.SANDBOXVARS_FILE_NOT_FOUND,
      });
    }

    const result: SandboxRepairResult = await withFileLock(
      filePath,
      async () => {
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

        const backup = await createBackup(
          configPath,
          `${serverName}_SandboxVars.lua`,
        );
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
        return {
          alreadyValid: false,
          repaired: true,
          changes,
          backupName: backup.name,
        };
      },
    );

    if (result.alreadyValid) {
      return res.json({
        success: true,
        alreadyValid: true,
        message: "SandboxVars.lua is already valid — no repair needed.",
      });
    }
    if (!result.repaired) {
      const body: JsonRecord = {
        success: false,
        error: result.error,
        code: result.code,
      };
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
    const { configPath, serverName } = await getRequestServerValues(req);
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
    const { configPath, serverName } = await getRequestServerValues(req);
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
    const { configPath, serverName } = await getRequestServerValues(req);
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
    const { configPath, serverName } = await getRequestServerValues(req);
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
    const { configPath, serverName } = await getRequestServerValues(req);
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
    const { configPath, serverName } = await getRequestServerValues(req);
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
        backupWarning = backupWarningFor(
          await writeIniWithBackup(filePath, contentToWrite),
        );
      } else {
        if (fs.existsSync(filePath)) {
          backupWarning = backupWarningFor(
            await createBackup(configPath, fileMap[type]),
          );
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
    const configPath = await getRequestServerConfigPath(req);
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
    const configPath = await getRequestServerConfigPath(req);
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

    const backupData = await fs.promises.readFile(backupPath);

    let preRestoreBackupWarning = null;
    await withFileLock(targetPath, async () => {
      if (fs.existsSync(targetPath)) {
        const backup = await createBackup(configPath, originalName);
        if (!backup.backedUp && backup.reason !== "no-source") {
          preRestoreBackupWarning = `Could not back up the current ${originalName} before restoring over it: ${backup.error}. The version that was in place before this restore is not recoverable through this panel.`;
        }
      }

      writeFileAtomic(targetPath, backupData);
    });

    log.info(`Restored from backup: ${filename} -> ${originalName}`);
    res.json({
      success: true,
      message: `Restored ${originalName} from backup`,
      ...(preRestoreBackupWarning
        ? { backupWarning: preRestoreBackupWarning }
        : {}),
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

export default router;
