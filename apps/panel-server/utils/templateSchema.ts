import crypto from "crypto";

type TemplateObject = Record<string, unknown>;
type TemplateChange = {
  key?: string;
  section?: string;
  from: unknown;
  to: unknown;
};
type CreateTemplateOptions = {
  name?: unknown;
  description?: unknown;
  tags?: unknown;
  pzBuild?: unknown;
  sandboxVars?: unknown;
  serverIni?: unknown;
  mods?: unknown;
  map?: unknown;
  difficulty?: unknown;
};

export const TEMPLATE_SCHEMA_VERSION = 1;

export const SANDBOX_SECTIONS = [
  "settings",
  "ZombieLore",
  "ZombieConfig",
  "MultiplierConfig",
  "Map",
  "Basement",
];

export const DEFAULT_INI_EXCLUSIONS = [
  "RCONPassword",
  "Password",
  "ServerName",
  "PublicName",
  "DefaultPort",
  "UDPPort",
  "RCONPort",
  "server_browser_announced_ip",
];

function asRecord(value: unknown): TemplateObject {
  return value && typeof value === "object" ? (value as TemplateObject) : {};
}

export function resolveIniExclusions(template: unknown): unknown[] {
  const object = asRecord(template);
  const extra = Array.isArray(object.iniExclusions) ? object.iniExclusions : [];
  return [...new Set([...DEFAULT_INI_EXCLUSIONS, ...extra])];
}

export function createTemplate({
  name,
  description,
  tags,
  pzBuild,
  sandboxVars,
  serverIni,
  mods,
  map,
  difficulty,
}: CreateTemplateOptions = {}): TemplateObject {
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    meta: {
      id: crypto.randomUUID(),
      name,
      description: description || "",
      tags: tags || [],
      pzBuild: pzBuild || "42",
      createdAt: new Date().toISOString(),
    },
    sandboxVars: sandboxVars || {},
    serverIni: serverIni || {},
    iniExclusions: [...DEFAULT_INI_EXCLUSIONS],
    mods: mods || [],
    map: map || { mapId: "Muldraugh, KY" },
    difficulty: difficulty || {},
  };
}

function isPlainObject(value: unknown): value is TemplateObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}

function validateFlatValueMap(
  obj: unknown,
  label: string,
  errors: string[],
): void {
  if (!isPlainObject(obj)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (!isPrimitive(value)) {
      errors.push(`${label}.${key} must be a string, number, or boolean`);
    }
  }
}

export function validateTemplate(template: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isPlainObject(template)) {
    return { valid: false, errors: ["Template must be an object"] };
  }

  if (template.schemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${TEMPLATE_SCHEMA_VERSION}`);
  }

  if (!isPlainObject(template.meta)) {
    errors.push("meta must be an object");
  } else {
    if (typeof template.meta.id !== "string" || !template.meta.id) {
      errors.push("meta.id must be a non-empty string");
    }
    if (typeof template.meta.name !== "string" || !template.meta.name.trim()) {
      errors.push("meta.name must be a non-empty string");
    }
    if (template.meta.tags !== undefined && !Array.isArray(template.meta.tags)) {
      errors.push("meta.tags must be an array");
    }
  }

  validateFlatValueMap(template.serverIni ?? {}, "serverIni", errors);

  if (!isPlainObject(template.sandboxVars ?? {})) {
    errors.push("sandboxVars must be an object");
  } else {
    for (const [section, values] of Object.entries(
      asRecord(template.sandboxVars),
    )) {
      if (!SANDBOX_SECTIONS.includes(section)) {
        errors.push(`sandboxVars.${section} is not a known section`);
        continue;
      }
      validateFlatValueMap(values, `sandboxVars.${section}`, errors);
    }
  }

  const exclusions = resolveIniExclusions(template);
  if (isPlainObject(template.serverIni)) {
    const leaked = Object.keys(template.serverIni).filter((key) =>
      exclusions.includes(key),
    );
    if (leaked.length > 0) {
      errors.push(
        `serverIni must not contain excluded keys: ${leaked.join(", ")}`,
      );
    }
  }

  if (template.mods !== undefined && !Array.isArray(template.mods)) {
    errors.push("mods must be an array");
  }
  if (template.map !== undefined && !isPlainObject(template.map)) {
    errors.push("map must be an object");
  }
  if (template.difficulty !== undefined && !isPlainObject(template.difficulty)) {
    errors.push("difficulty must be an object");
  }

  return { valid: errors.length === 0, errors };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return String(a).trim() === String(b).trim();
}

export function diffTemplate(
  template: unknown,
  currentConfig: unknown = {},
): {
  serverIni: TemplateChange[];
  sandboxVars: TemplateChange[];
  summary: { iniChanges: number; sandboxChanges: number; totalChanges: number };
} {
  const templateObject = asRecord(template);
  const currentObject = asRecord(currentConfig);
  const exclusions = resolveIniExclusions(template);
  const currentServerIni = asRecord(currentObject.serverIni);

  const serverIni: TemplateChange[] = [];
  for (const [key, to] of Object.entries(asRecord(templateObject.serverIni))) {
    if (exclusions.includes(key)) continue;
    const from = currentServerIni[key];
    if (!valuesEqual(from, to)) serverIni.push({ key, from, to });
  }

  const sandboxVars: TemplateChange[] = [];
  const currentSandboxVars = asRecord(currentObject.sandboxVars);
  for (const [section, values] of Object.entries(
    asRecord(templateObject.sandboxVars),
  )) {
    const currentSection = asRecord(currentSandboxVars[section]);
    for (const [key, to] of Object.entries(asRecord(values))) {
      const from = currentSection[key];
      if (!valuesEqual(from, to)) sandboxVars.push({ section, key, from, to });
    }
  }

  return {
    serverIni,
    sandboxVars,
    summary: {
      iniChanges: serverIni.length,
      sandboxChanges: sandboxVars.length,
      totalChanges: serverIni.length + sandboxVars.length,
    },
  };
}
