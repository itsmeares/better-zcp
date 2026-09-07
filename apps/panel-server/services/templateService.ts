import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { sanitizeErrorParams } from "../utils/sanitize.ts";
import { getServer, getSetting, setSetting } from "../database/init.ts";
import {
  getUserTemplates,
  getUserTemplate,
  saveUserTemplate,
  deleteUserTemplate,
} from "../database/init.ts";
import {
  createTemplate,
  validateTemplate,
  diffTemplate as computeDiff,
  resolveIniExclusions,
} from "../utils/templateSchema.ts";
import {
  readIniValues,
  mergeIniValues,
  readSandboxValue,
  mergeSandboxSections,
  backupFile,
  writeFilesTransaction,
} from "../utils/templateFiles.ts";
import { withFileLock } from "../utils/fileWriteQueue.ts";

const log = createLogger("TemplateService");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.join(__dirname, "../data/templates");

type TemplateValues = Record<string, unknown>;

interface TemplateMeta {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface TemplateRecord {
  schemaVersion: number;
  meta: TemplateMeta;
  serverIni?: TemplateValues;
  sandboxVars?: Record<string, TemplateValues>;
  iniExclusions?: unknown[];
  mods?: unknown[];
  map?: TemplateValues;
  difficulty?: TemplateValues;
  [key: string]: unknown;
}

type BuiltinTemplate = TemplateRecord & { isBuiltin: boolean };

interface ServerProfile {
  id: string | number;
  serverConfigPath?: string | null;
  zomboidDataPath?: string | null;
  serverName?: string | null;
  isRemote?: boolean;
}

interface ServerPaths {
  iniPath: string;
  sandboxPath: string;
}

interface TemplateFileChange {
  filePath: string;
  content: string;
  original: string;
  existed: boolean;
}

interface ApplyResult {
  success: true;
  ini: { appliedKeys: string[]; skippedKeys: string[] } | null;
  sandbox: {
    applied: Array<{ section: string; key: string }>;
    skipped: Array<{ section: string; key: string }>;
  } | { skipped: true; reason: string } | null;
  backups: string[];
}

interface ApplyOptions {
  backup?: boolean;
  applyIni?: boolean;
  applySandbox?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTemplateRecord(value: unknown): value is TemplateRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const meta = record.meta;
  return (
    typeof record.schemaVersion === "number" &&
    Boolean(meta) &&
    typeof meta === "object" &&
    !Array.isArray(meta) &&
    typeof (meta as Record<string, unknown>).id === "string" &&
    typeof (meta as Record<string, unknown>).name === "string"
  );
}

let builtinCache: BuiltinTemplate[] | null = null;
const HIDDEN_BUILTIN_TEMPLATES_SETTING = "hiddenBuiltinTemplateIds";

async function getHiddenBuiltinTemplateIds(): Promise<Set<string>> {
  const stored = await getSetting(HIDDEN_BUILTIN_TEMPLATES_SETTING);
  return Array.isArray(stored)
    ? new Set(stored.filter((id) => typeof id === "string"))
    : new Set();
}

function loadBuiltinTemplates(): BuiltinTemplate[] {
  if (builtinCache) return builtinCache;
  const files = fs.existsSync(BUILTIN_DIR)
    ? fs.readdirSync(BUILTIN_DIR).filter((f) => f.endsWith(".json"))
    : [];
  builtinCache = files
    .map((f) => {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(path.join(BUILTIN_DIR, f), "utf-8"));
        if (!isTemplateRecord(raw)) throw new Error("invalid template shape");
        return { ...raw, isBuiltin: true };
      } catch (err) {
        log.error(`Failed to load built-in template ${f}: ${errorMessage(err)}`);
        return null;
      }
    })
    .filter((template): template is BuiltinTemplate => template !== null);
  return builtinCache;
}

export function _resetBuiltinCacheForTests() {
  builtinCache = null;
}

export async function listTemplates(): Promise<Array<TemplateRecord | BuiltinTemplate>> {
  const hiddenBuiltinIds = await getHiddenBuiltinTemplateIds();
  const builtins = loadBuiltinTemplates().filter(
    (template) => !hiddenBuiltinIds.has(template.meta.id),
  );
  const userTemplates = (await getUserTemplates() as TemplateRecord[]).map((t) => ({
    ...t,
    isBuiltin: false,
  }));
  return [...builtins, ...userTemplates];
}

export async function getTemplate(id: string): Promise<TemplateRecord | BuiltinTemplate | null> {
  const hiddenBuiltinIds = await getHiddenBuiltinTemplateIds();
  const builtin = loadBuiltinTemplates().find((t) => t.meta.id === id);
  if (builtin) return hiddenBuiltinIds.has(id) ? null : builtin;
  const userTemplate = await getUserTemplate(id);
  return userTemplate
    ? { ...(userTemplate as TemplateRecord), isBuiltin: false }
    : null;
}

export async function saveTemplate(input: unknown) {
  const inputRecord =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const inputMeta =
    inputRecord?.meta &&
    typeof inputRecord.meta === "object" &&
    !Array.isArray(inputRecord.meta)
      ? (inputRecord.meta as Record<string, unknown>)
      : null;
  const inputId = typeof inputMeta?.id === "string" ? inputMeta.id : "";
  const hasId = Boolean(inputId);
  if (hasId && loadBuiltinTemplates().some((t) => t.meta.id === inputId)) {
    return {
      success: false,
      error: "Cannot overwrite a built-in template",
      code: ErrorCode.SIM_TEMPLATE_BUILTIN_READONLY,
    };
  }

  const template = (
    hasId && inputRecord && "schemaVersion" in inputRecord
      ? inputRecord
      : createTemplate(
          inputRecord
            ? (inputRecord as Parameters<typeof createTemplate>[0])
            : {},
        )
  ) as TemplateRecord;
  const { valid, errors } = validateTemplate(template);
  if (!valid) {
    const joined = errors.join("; ");
    return {
      success: false,
      error: joined,
      code: ErrorCode.SIM_TEMPLATE_VALIDATION_FAILED,
      params: sanitizeErrorParams({ errors: joined }),
    };
  }

  const saved = await saveUserTemplate(template);
  return { success: true, template: saved };
}

export async function deleteTemplate(id: string) {
  if (loadBuiltinTemplates().some((t) => t.meta.id === id)) {
    const hiddenBuiltinIds = await getHiddenBuiltinTemplateIds();
    hiddenBuiltinIds.add(id);
    await setSetting(HIDDEN_BUILTIN_TEMPLATES_SETTING, [...hiddenBuiltinIds]);
    return { success: true, hiddenBuiltin: true };
  }
  const deleted = await deleteUserTemplate(id);
  return deleted
    ? { success: true }
    : { success: false, error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND };
}

export async function listHiddenBuiltinTemplates(): Promise<BuiltinTemplate[]> {
  const hiddenBuiltinIds = await getHiddenBuiltinTemplateIds();
  if (hiddenBuiltinIds.size === 0) return [];
  return loadBuiltinTemplates().filter((template) =>
    hiddenBuiltinIds.has(template.meta.id),
  );
}

export async function unhideTemplate(id: string) {
  const hiddenBuiltinIds = await getHiddenBuiltinTemplateIds();
  if (!hiddenBuiltinIds.has(id)) {
    return { success: false, error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND };
  }
  hiddenBuiltinIds.delete(id);
  await setSetting(HIDDEN_BUILTIN_TEMPLATES_SETTING, [...hiddenBuiltinIds]);
  return { success: true };
}

export async function exportTemplate(id: string) {
  const template = await getTemplate(id);
  if (!template) {
    return { success: false, error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND };
  }
  const { isBuiltin: _isBuiltin, ...exportable } = template;
  return { success: true, template: exportable };
}

export async function importTemplate(json: unknown) {
  const { valid, errors } = validateTemplate(json);
  if (!valid) {
    const joined = errors.join("; ");
    return {
      success: false,
      error: joined,
      code: ErrorCode.SIM_TEMPLATE_VALIDATION_FAILED,
      params: sanitizeErrorParams({ errors: joined }),
    };
  }

  const template = {
    ...(json as TemplateRecord),
    meta: { ...(json as TemplateRecord).meta, id: randomUUID() },
  } satisfies TemplateRecord;
  const saved = await saveUserTemplate(template);
  return { success: true, template: saved };
}

function resolveServerPaths(
  server: ServerProfile | null | undefined,
): ServerPaths | null {
  const configDir = server?.serverConfigPath
    ? server.serverConfigPath
    : server?.zomboidDataPath
      ? path.join(server.zomboidDataPath, "Server")
      : null;
  if (
    !configDir ||
    typeof server?.serverName !== "string" ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_ -]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/.test(
      server.serverName,
    )
  ) {
    return null;
  }
  return {
    iniPath: path.join(configDir, `${server.serverName}.ini`),
    sandboxPath: path.join(configDir, `${server.serverName}_SandboxVars.lua`),
  };
}

async function readCurrentConfig(
  template: TemplateRecord | BuiltinTemplate,
  paths: ServerPaths,
) {
  const serverIni: TemplateValues = {};
  if (fs.existsSync(paths.iniPath)) {
    const content = fs.readFileSync(paths.iniPath, "utf-8");
    Object.assign(serverIni, readIniValues(content, Object.keys(template.serverIni || {})));
  }

  const sandboxVars: Record<string, TemplateValues> = {};
  if (fs.existsSync(paths.sandboxPath)) {
    const content = fs.readFileSync(paths.sandboxPath, "utf-8");
    for (const [section, values] of Object.entries(template.sandboxVars || {})) {
      const sectionValues: TemplateValues = {};
      for (const key of Object.keys(values || {})) {
        sectionValues[key] = readSandboxValue(content, section, key);
      }
      sandboxVars[section] = sectionValues;
    }
  }

  return { serverIni, sandboxVars };
}

export async function previewTemplate(templateId: string, serverId: string) {
  const template = await getTemplate(templateId);
  if (!template) {
    return { success: false, error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND };
  }

  const server = (await getServer(serverId)) as ServerProfile | null;
  if (!server) {
    return { success: false, error: "Server not found", code: ErrorCode.SIM_TEMPLATE_SERVER_NOT_FOUND };
  }

  const paths = resolveServerPaths(server);
  if (!paths) {
    return {
      success: false,
      error: "Server has no configured config path",
      code: ErrorCode.SIM_TEMPLATE_SERVER_NO_CONFIG_PATH,
    };
  }

  const currentConfig = await readCurrentConfig(template, paths);
  return { success: true, diff: computeDiff(template, currentConfig) };
}

function prepareIniChange(
  template: TemplateRecord | BuiltinTemplate,
  paths: ServerPaths,
  result: ApplyResult,
): TemplateFileChange | null {
  const exclusions = resolveIniExclusions(template);
  const requested = Object.fromEntries(
    Object.entries(template.serverIni || {}).filter(([key]) => !exclusions.includes(key)),
  );
  if (Object.keys(requested).length === 0) return null;
  if (!fs.existsSync(paths.iniPath)) {
    throw new Error("Server INI file not found");
  }

  const existing = fs.readFileSync(paths.iniPath, "utf-8");
  const current = readIniValues(existing, Object.keys(requested));
  const updates = Object.fromEntries(
    Object.entries(requested).filter(([key]) =>
      Object.prototype.hasOwnProperty.call(current, key),
    ),
  );
  const skippedKeys = Object.keys(requested).filter(
    (key) => !Object.prototype.hasOwnProperty.call(current, key),
  );
  result.ini = { appliedKeys: Object.keys(updates), skippedKeys };
  if (Object.keys(updates).length === 0) return null;
  return {
    filePath: paths.iniPath,
    content: mergeIniValues(existing, updates),
    original: existing,
    existed: true,
  };
}

function prepareSandboxChange(
  template: TemplateRecord | BuiltinTemplate,
  paths: ServerPaths,
  result: ApplyResult,
): TemplateFileChange | null {
  if (Object.keys(template.sandboxVars || {}).length === 0) return null;

  if (!fs.existsSync(paths.sandboxPath)) {
    result.sandbox = {
      skipped: true,
      reason: "SandboxVars.lua not found — start the server once to generate it.",
    };
    return null;
  }

  const existing = fs.readFileSync(paths.sandboxPath, "utf-8");
  const { content, applied, skipped } = mergeSandboxSections(existing, template.sandboxVars);
  result.sandbox = { applied, skipped };
  if (applied.length === 0) return null;
  return {
    filePath: paths.sandboxPath,
    content,
    original: existing,
    existed: true,
  };
}

function applyTemplateLocked(
  template: TemplateRecord | BuiltinTemplate,
  paths: ServerPaths,
  backup: boolean,
  options: ApplyOptions,
): ApplyResult {
  const result: ApplyResult = { success: true, ini: null, sandbox: null, backups: [] };
  const changes = [
    options.applyIni === false ? null : prepareIniChange(template, paths, result),
    options.applySandbox === false ? null : prepareSandboxChange(template, paths, result),
  ].filter((change): change is TemplateFileChange => change !== null);

  if (backup) {
    for (const change of changes) {
      const backupPath = backupFile(change.filePath);
      if (backupPath) result.backups.push(backupPath);
    }
  }
  writeFilesTransaction(changes);
  return result;
}

export async function applyTemplate(
  templateId: string,
  serverId: string,
  options: ApplyOptions = {},
) {
  const template = await getTemplate(templateId);
  if (!template) {
    return { success: false, error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND };
  }

  const server = (await getServer(serverId)) as ServerProfile | null;
  if (!server) {
    return { success: false, error: "Server not found", code: ErrorCode.SIM_TEMPLATE_SERVER_NOT_FOUND };
  }
  if (server.isRemote) {
    return {
      success: false,
      error: "Applying templates to remote servers is not supported yet.",
      code: ErrorCode.SIM_TEMPLATE_APPLY_REMOTE_UNSUPPORTED,
    };
  }

  const paths = resolveServerPaths(server);
  if (!paths) {
    return {
      success: false,
      error: "Server has no configured config path",
      code: ErrorCode.SIM_TEMPLATE_SERVER_NO_CONFIG_PATH,
    };
  }

  const backup = options.backup !== false;
  const lockPaths = [paths.iniPath, paths.sandboxPath].sort();
  let result;
  try {
    result = await withFileLock(lockPaths[0], () =>
      withFileLock(lockPaths[1], () =>
        applyTemplateLocked(template, paths, backup, options),
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Server INI file not found") {
      return {
        success: false,
        error: error.message,
        code: ErrorCode.SIM_TEMPLATE_APPLY_INI_MISSING,
      };
    }
    throw error;
  }

  log.info(`Applied template "${template.meta.name}" to server ${server.id}`);
  return result;
}
