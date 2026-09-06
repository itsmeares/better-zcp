import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "..", "panel-client", "src", "locales");
const SOURCE_LANGUAGE = "en";

function flattenCapabilityDescriptions(obj, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object") {
      if (typeof value.description === "string") {
        out[prefix ? `${prefix}.${key}` : key] = value.description;
      } else {
        Object.assign(
          out,
          flattenCapabilityDescriptions(value, prefix ? `${prefix}.${key}` : key),
        );
      }
    }
  }
  return out;
}

function readCapabilityDescriptions(languageCode) {
  const rolesPath = path.join(LOCALES_DIR, languageCode, "roles.json");
  const roles = JSON.parse(fs.readFileSync(rolesPath, "utf8"));
  return flattenCapabilityDescriptions(roles.capabilities);
}

const targetLanguages = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name !== SOURCE_LANGUAGE &&
      fs.existsSync(path.join(LOCALES_DIR, entry.name, "roles.json")),
  )
  .map((entry) => entry.name)
  .sort();

const englishDescriptions = readCapabilityDescriptions(SOURCE_LANGUAGE);

describe("capability description staleness: every non-English locale's roles.json vs en/roles.json", () => {
  it("sanity check: found a non-trivial number of capabilities in English, and at least one other language to check (guards against a silently-empty parse or an empty locales dir)", () => {
    expect(Object.keys(englishDescriptions).length).toBeGreaterThan(20);
    expect(targetLanguages.length).toBeGreaterThan(0);
  });

  for (const lang of targetLanguages) {
    describe(lang, () => {
      const localeDescriptions = readCapabilityDescriptions(lang);

      it("has a capabilities entry for every en/roles.json capability", () => {
        const missing = Object.keys(englishDescriptions).filter(
          (key) => !(key in localeDescriptions),
        );
        expect(
          missing,
          missing.length
            ? `apps/panel-client/src/locales/${lang}/roles.json is missing a capabilities entry for: ${missing.join(", ")}`
            : "",
        ).toEqual([]);
      });

      it("has no description left byte-identical to the current English text (untranslated or silently reset)", () => {
        const stale = Object.keys(englishDescriptions).filter((key) => {
          const localeDesc = localeDescriptions[key];
          if (localeDesc === undefined) return false;
          return localeDesc === englishDescriptions[key];
        });
        expect(
          stale,
          stale.length
            ? `apps/panel-client/src/locales/${lang}/roles.json has description(s) byte-identical to English (untranslated or drifted back to source) for: ${stale.join(", ")}`
            : "",
        ).toEqual([]);
      });
    });
  }
});
