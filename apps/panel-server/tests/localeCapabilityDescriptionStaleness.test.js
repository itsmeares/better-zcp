import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "..", "panel-client", "src", "locales");
const SOURCE_LANGUAGE = "en";

// permissionsDescriptionRegistry.test.js (this directory) enforces
// apps/panel-server/services/permissions.js <-> apps/panel-client/src/locales/en/roles.json --
// English, and only English. RolesPermissions.tsx renders
// `t('capabilities.<key>.description', { defaultValue: cap.description })`
// per-LANGUAGE, so a de/es/fr/ht/zh-CN description can drift out of date
// with zero enforcement anywhere in the repo: localeParity.test.ts (client
// side) checks every locale has the same KEY SET as en, but its own header
// comment says so explicitly -- "the key-set/empty-string checks below say
// nothing about what's INSIDE a value that does exist". Content is only
// ever checked against English. This is that missing check, generalized to
// every non-English locale.
//
// This is not hypothetical for THIS registry specifically: bridge.diagnostics'
// server description was corrected 2026-08-27 (commit d490410) to stop
// promising unreachable debug-log/stats access, then en/roles.json was fixed
// separately in the same conversation because nothing enforced the two
// staying in sync -- exactly the drift permissionsDescriptionRegistry.test.js
// now catches for English. Nothing catches the same class of drift for the
// other five languages once en/roles.json itself changes out from under them.
// And 6fada8c raised the stakes: eight of these descriptions exist
// specifically to disclose a DANGEROUS capability (walking a credential
// store off the host, etc.) -- a stale non-English translation of one of
// those doesn't just read awkwardly, it undersells real power to an
// operator reading in their own language.
//
// CONTENT EQUALITY IS THE WRONG CHECK ACROSS LANGUAGES (a real French
// sentence is never byte-identical to its English source), so this can't
// reuse permissionsDescriptionRegistry.test.js's exact-match approach. What
// IS reusable in translation: a real translation is never byte-identical to
// the English original either. A non-English description that IS
// byte-identical to en's current text is either untranslated (copy-pasted
// as a placeholder and never revisited) or was translated once and then
// silently reset/overwritten back to the English source -- either way, the
// operator reading that language sees English, unannounced. That is the
// staleness signal this file checks; it does NOT check whether an existing
// translation is semantically faithful to English (that needs a human or a
// translator, not a string compare) -- only whether it still IS a
// translation at all.
//
// Both candidate shapes from the card verified empirically before writing
// this gate, not assumed:
//   (1) every locale has an entry for every en/roles.json capability --
//       VERIFIED true for all five languages as of 2026-08-27 (0 missing
//       keys each), and is ALSO already transitively guaranteed by two
//       existing tests working together even without this file:
//       permissionsDescriptionRegistry.test.js requires every permissions.js
//       capability to exist in en/roles.json, and localeParity.test.ts (client
//       side) requires every locale to mirror en's full key set. Re-asserted
//       here anyway as this file's own sanity check, scoped specifically to
//       the capabilities substructure, so a failure here points straight at
//       "a locale's roles.json capabilities section" rather than a generic
//       whole-tree key diff.
//   (2) byte-identical-to-English descriptions -- THE actual staleness
//       gate below. VERIFIED the check itself is not silently vacuous by a
//       real positive control before trusting its result: mutated a
//       scratch COPY of a real locale file (fr/roles.json) to make one
//       description byte-identical to English, ran this exact
//       read-parse-flatten-compare pipeline against that copy, and
//       confirmed it reported exactly the one mutated key -- see
//       conversation regression (2026-08-27) for the transcript.
//       Only after that did the real (unmutated) result -- 0 stale
//       descriptions across all five languages, 28 capabilities each -- get
//       trusted and reported rather than assumed clean.
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

// Discovered, not named -- a newly added language folder is picked up
// automatically, same reasoning as localeParity.test.ts's own discovery
// (a hardcoded list silently stops covering the next language added).
// Filtered by "has its own roles.json", not just "is a directory" --
// apps/panel-client/src/locales/ also holds a __tests__ directory (localeParity.test.ts
// and friends) that is not a language and has no roles.json of its own.
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
          if (localeDesc === undefined) return false; // already reported by the missing-entry test above
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
