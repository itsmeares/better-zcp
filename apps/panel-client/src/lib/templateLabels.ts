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
  const setting = getSandboxSetting(key, section);
  return setting ? getSandboxSettingLabel(setting) : humanizeTemplateKey(key);
}

export function formatDifficultyLabel(level: string | undefined): string {
  if (!level) return resolveRegisteredTranslation("templateCard", "custom", undefined) ?? "Custom";
  return level
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => ACRONYM_LABELS[word.toLowerCase()] || word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

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
