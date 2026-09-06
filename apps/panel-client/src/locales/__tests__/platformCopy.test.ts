import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const localeRoot = path.resolve(process.cwd(), "src/locales");
const locales = fs.readdirSync(localeRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("__"))
  .map((entry) => entry.name);

function read(locale: string, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, `${file}.json`), "utf8"));
}

function get(source: Record<string, unknown>, key: string): string {
  return key.split(".").reduce<unknown>((value, part) => (
    value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined
  ), source) as string;
}

describe("platform-specific help copy", () => {
  const neutralKeys: Array<[string, string]> = [
    ["settings", "updates.helperLogHint"],
    ["settings", "updates.permissionDenied"],
    ["settings", "https.certPathPlaceholder"],
    ["settings", "https.keyPathPlaceholder"],
    ["serverSetup", "common.customDataPathPlaceholder"],
    ["serverSetup", "full.step1.manualStep2"],
    ["serverSetup", "full.step2.installFolderPlaceholder"],
    ["serverSetup", "quick.step1.usingExistingDesc"],
    ["servers", "localForm.installPathPlaceholder"],
    ["servers", "editDialog.customStartCommandPlaceholder"],
    ["chunkCleaner", "save.customPathPlaceholder"],
    ["chunkCleaner", "save.customPathHint"],
  ];

  it.each(locales)("keeps neutral fallback copy OS-agnostic in %s", (locale) => {
    for (const [file, key] of neutralKeys) {
      const value = get(read(locale, file), key);
      expect(value, `${locale}/${file}:${key}`).toBeTypeOf("string");
      expect(value, `${locale}/${file}:${key}`).not.toMatch(
        /%TEMP%|%PATH%|%USERPROFILE%|[A-Z]:\\|Start\.bat|StartServer64\.bat|start-server\.sh|\$HOME|~\/|\b(?:chmod|chown|systemctl)\b/i,
      );
    }
  });

  it.each(locales)("keeps TEMP and PATH syntax inside platform variants in %s", (locale) => {
    const settings = read(locale, "settings");
    const debug = read(locale, "debug");
    expect(get(settings, "updates.helperLogHintWindows")).toContain("%TEMP%");
    expect(get(settings, "updates.helperLogHintPosix")).not.toContain("%TEMP%");
    expect(get(debug, "diagnostics.checks.server.jre.warn.windows.message")).toContain("%PATH%");
    expect(get(debug, "diagnostics.checks.server.jre.warn.linux.message")).toContain("$PATH");
  });
});
