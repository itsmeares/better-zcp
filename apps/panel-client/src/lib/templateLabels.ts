/**
 * Human-readable labels for simulation template diffs (apps/panel-server/routes/templates.js).
 * Prefers the descriptive labels already curated in serverConfigSchema.ts;
 * falls back to splitting the raw PZ key (e.g. "PVPMeleeDamageModifier")
 * into words for settings that schema doesn't (yet) describe.
 */
import {
  getIniSetting,
  getSandboxSetting,
  getIniSettingLabel,
  getSandboxSettingLabel,
} from "./serverConfigSchema";
import { resolveRegisteredTranslation } from "./paramTranslation";

const ACRONYM_LABELS: Record<string, string> = {
  pvp: "PVP",
};

/** Splits a PascalCase/camelCase PZ config key into spaced words. */
export function humanizeTemplateKey(key: string): string {
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getIniKeyLabel(key: string): string {
  const setting = getIniSetting(key);
  return setting ? getIniSettingLabel(setting) : humanizeTemplateKey(key);
}

export function getSandboxKeyLabel(key: string, section?: string): string {
  // section disambiguates the handful of keys PZ reuses across two
  // unrelated SandboxVars.lua tables (Farming, Strength) -- see
  // getSandboxSetting's own comment. Callers with a diff row's own
  // `section` field (TemplateDiffList) should always pass it.
  const setting = getSandboxSetting(key, section);
  return setting ? getSandboxSettingLabel(setting) : humanizeTemplateKey(key);
}

/** e.g. "hardcore" -> "Hardcore", "pvp" -> "PVP", "first-week" -> "First Week". */
export function formatDifficultyLabel(level: string | undefined): string {
  if (!level) return resolveRegisteredTranslation("templateCard", "custom", undefined) ?? "Custom";
  return level
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => ACRONYM_LABELS[word.toLowerCase()] || word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** Renders a diff value for display: booleans as On/Off, undefined as "(not set)". */
export function formatDiffValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return resolveRegisteredTranslation("templateDiffList", "notSet", undefined) ?? "(not set)";
  }
  if (typeof value === "boolean") {
    return resolveRegisteredTranslation("templateDiffList", value ? "on" : "off", undefined) ?? (value ? "On" : "Off");
  }
  if (value === "true" || value === "false") {
    const isOn = value === "true";
    return resolveRegisteredTranslation("templateDiffList", isOn ? "on" : "off", undefined) ?? (isOn ? "On" : "Off");
  }
  return String(value);
}
