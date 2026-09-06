import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { sanitizeErrorParams } from "../utils/sanitize.js";
import { getServer, getSetting, setSetting } from "../database/init.js";
import {
  getUserTemplates,
  getUserTemplate,
  saveUserTemplate,
  deleteUserTemplate,
} from "../database/init.js";
import {
  createTemplate,
  validateTemplate,
  diffTemplate as computeDiff,
  resolveIniExclusions,
} from "../utils/templateSchema.js";
import {
  readIniValues,
  mergeIniValues,
  readSandboxValue,
  mergeSandboxSections,
  backupFile,
  writeFilesTransaction,
} from "../utils/templateFiles.js";
import { withFileLock } from "../utils/fileWriteQueue.js";

const log = createLogger("TemplateService");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.join(__dirname, "../data/templates");

let builtinCache = null;
const HIDDEN_BUILTIN_TEMPLATES_SETTING = "hiddenBuiltinTemplateIds";

async function getHiddenBuiltinTemplateIds() {
  const stored = await getSetting(HIDDEN_BUILTIN_TEMPLATES_SETTING);
  return Array.isArray(stored)
    ? new Set(stored.filter((id) => typeof id === "string"))
    : new Set();
}

function loadBuiltinTemplates() {
  if (builtinCache) return builtinCache;
  const files = fs.existsSync(BUILTIN_DIR)
    ? fs.readdirSync(BUILTIN_DIR).filter((f) => f.endsWith(".json"))
    : [];
  builtinCache = files
    .map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(BUILTIN_DIR, f), "utf-8"));
        return { ...raw, isBuiltin: true };
      } catch (err) {
        log.error(`Failed to load built-in template ${f}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
  return builtinCache;
}

export function _resetBuiltinCacheForTests() {
  builtinCache = null;
}

export async function listTemplates() {
  const hiddenBuiltinIds = await getHiddenBuiltinTemplateIds();
  const builtins = loadBuiltinTemplates().filter(
    (template) => !hiddenBuiltinIds.has(template.meta.id),
  );
  const userTemplates = (await getUserTemplates()).map((t) => ({
    ...t,
    isBuiltin: false,
  }));
  return [...builtins, ...userTemplates];
}

export async function getTemplate(id) {
  const hiddenBuiltinIds = await getHiddenBuiltinTemplateIds();
  const builtin = loadBuiltinTemplates().find((t) => t.meta.id === id);
  if (builtin) return hiddenBuiltinIds.has(id) ? null : builtin;
  const userTemplate = await getUserTemplate(id);
  return userTemplate ? { ...userTemplate, isBuiltin: false } : null;
}

export async function saveTemplate(input) {
  const hasId = typeof input?.meta?.id === "string" && input.meta.id;
  if (hasId && loadBuiltinTemplates().some((t) => t.meta.id === input.meta.id)) {
    return {
      success: false,
      error: "Cannot overwrite a built-in template",
      code: ErrorCode.SIM_TEMPLATE_BUILTIN_READONLY,
    };
  }

  const template = hasId && input.schemaVersion ? input : createTemplate(input || {});
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

export async function deleteTemplate(id) {
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

export async function listHiddenBuiltinTemplates() {
  const hiddenBuiltinIds = await getHiddenBuiltinTemplateIds();
  if (hiddenBuiltinIds.size === 0) return [];
  return loadBuiltinTemplates().filter((template) =>
    hiddenBuiltinIds.has(template.meta.id),
  );
}

export async function unhideTemplate(id) {
  const hiddenBuiltinIds = await getHiddenBuiltinTemplateIds();
  if (!hiddenBuiltinIds.has(id)) {
    return { success: false, error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND };
  }
  hiddenBuiltinIds.delete(id);
  await setSetting(HIDDEN_BUILTIN_TEMPLATES_SETTING, [...hiddenBuiltinIds]);
  return { success: true };
}

export async function exportTemplate(id) {
  const template = await getTemplate(id);
  if (!template) {
    return { success: false, error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND };
  }
  const { isBuiltin: _isBuiltin, ...exportable } = template;
  return { success: true, template: exportable };
}

export async function importTemplate(json) {
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

  const template = { ...json, meta: { ...json.meta, id: randomUUID() } };
  const saved = await saveUserTemplate(template);
  return { success: true, template: saved };
}

function resolveServerPaths(server) {
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

async function readCurrentConfig(template, paths) {
  const serverIni = {};
  if (fs.existsSync(paths.iniPath)) {
    const content = fs.readFileSync(paths.iniPath, "utf-8");
    Object.assign(serverIni, readIniValues(content, Object.keys(template.serverIni || {})));
  }

  const sandboxVars = {};
  if (fs.existsSync(paths.sandboxPath)) {
    const content = fs.readFileSync(paths.sandboxPath, "utf-8");
    for (const [section, values] of Object.entries(template.sandboxVars || {})) {
      sandboxVars[section] = {};
      for (const key of Object.keys(values || {})) {
        sandboxVars[section][key] = readSandboxValue(content, section, key);
      }
    }
  }

  return { serverIni, sandboxVars };
}

export async function previewTemplate(templateId, serverId) {
  const template = await getTemplate(templateId);
  if (!template) {
    return { success: false, error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND };
  }

  const server = await getServer(serverId);
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

function prepareIniChange(template, paths, result) {
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

function prepareSandboxChange(template, paths, result) {
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

function applyTemplateLocked(template, paths, backup, options) {
  const result = { success: true, ini: null, sandbox: null, backups: [] };
  const changes = [
    options.applyIni === false ? null : prepareIniChange(template, paths, result),
    options.applySandbox === false ? null : prepareSandboxChange(template, paths, result),
  ].filter(Boolean);

  if (backup) {
    for (const change of changes) {
      const backupPath = backupFile(change.filePath);
      if (backupPath) result.backups.push(backupPath);
    }
  }
  writeFilesTransaction(changes);
  return result;
}

export async function applyTemplate(templateId, serverId, options = {}) {
  const template = await getTemplate(templateId);
  if (!template) {
    return { success: false, error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND };
  }

  const server = await getServer(serverId);
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
