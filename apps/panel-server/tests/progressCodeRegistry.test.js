import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ProgressCode } from "../utils/progressCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(SERVER_DIR, "..", "..");
const SERVER_JS_PATH = path.join(SERVER_DIR, "routes", "server.js");
const EN_LOCALE_PATH = path.join(
  REPO_ROOT,
  "apps/panel-client/src/locales/en/installProgress.json",
);

// Own instance for the 2026-08-22 install/SteamCMD progress i18n work --
// modeled on errorCodeRegistry.test.js (registry-membership structure) and
// diagnosticsCheckRegistry.test.js (the bidirectional stale-entry half),
// but not a reuse of either: every ProgressCode reference in server.js is
// `ProgressCode.SOME_CODE` member access (enforced by review, not a lint
// rule), never a bare string literal the way `code: "..."` sometimes is --
// so this scans for that access pattern instead of errorCodeRegistry's
// CODE_LITERAL_RE string-literal regex. That also means a code assigned to
// an intermediate variable before being emitted (e.g. the steam:complete
// 5-way branch) is still found: the regex matches the reference wherever it
// appears in source, not just inside an object literal passed straight to
// emit().
//
// fr/installProgress.json parity with en is NOT re-checked here -- that's
// already covered unconditionally for every locale namespace, this one
// included, by apps/panel-client/src/locales/__tests__/localeParity.test.ts. Re-adding
// it here would be the "one mechanism, two implementations" shape this
// floor has been correcting all night.
const PROGRESS_CODE_REF_RE = /\bProgressCode\.([A-Z][A-Z0-9_]*)\b/g;

function findReferencedCodes() {
  const source = fs.readFileSync(SERVER_JS_PATH, "utf8");
  const found = new Set();
  let match;
  PROGRESS_CODE_REF_RE.lastIndex = 0;
  while ((match = PROGRESS_CODE_REF_RE.exec(source))) {
    found.add(match[1]);
  }
  return found;
}

const referencedCodes = findReferencedCodes();
const registryCodes = new Set(Object.keys(ProgressCode));
const enLocale = JSON.parse(fs.readFileSync(EN_LOCALE_PATH, "utf8"));
const enKeys = new Set(Object.keys(enLocale));

describe("install/SteamCMD progress codes: registry membership (structure, not meaning)", () => {
  it("sanity check: the scan actually finds codes known to exist today (guards against the regex silently matching nothing)", () => {
    expect(referencedCodes.size).toBeGreaterThan(20);
    expect(referencedCodes.has("STEAMCMD_INSTALL_COMPLETE")).toBe(true);
    expect(referencedCodes.has("STEAM_START_VERIFY")).toBe(true);
  });

  it("every ProgressCode.* reference in apps/panel-server/routes/server.js is a registered ProgressCode value", () => {
    const unregistered = [...referencedCodes].filter(
      (code) => !registryCodes.has(code),
    );
    expect(
      unregistered,
      unregistered.length
        ? `Found ${unregistered.length} ProgressCode.* reference(s) not in apps/panel-server/utils/progressCodes.js: ${unregistered.join(", ")}`
        : "",
    ).toEqual([]);
  });

  // The half people forget: a registry entry no longer referenced anywhere
  // in source -- either dead from the start or orphaned by a later edit.
  // "no entry survives for a code that was removed" applies from BOTH the
  // source side (this) and the locale side (below).
  it("every registered ProgressCode value is referenced at least once in apps/panel-server/routes/server.js", () => {
    const unused = [...registryCodes].filter(
      (code) => !referencedCodes.has(code),
    );
    expect(
      unused,
      unused.length
        ? `${unused.length} ProgressCode entr(y/ies) registered but never emitted: ${unused.join(", ")}. Remove from progressCodes.js and its locale entries, or wire it up.`
        : "",
    ).toEqual([]);
  });

  it("every registered ProgressCode value has a matching key in apps/panel-client/src/locales/en/installProgress.json", () => {
    const missing = [...registryCodes].filter((code) => !enKeys.has(code));
    expect(
      missing,
      missing.length
        ? `apps/panel-client/src/locales/en/installProgress.json is missing an entry for: ${missing.join(", ")}`
        : "",
    ).toEqual([]);
  });

  it("every key in apps/panel-client/src/locales/en/installProgress.json is a registered ProgressCode value (no stale entries for a removed code)", () => {
    const stale = [...enKeys].filter((key) => !registryCodes.has(key));
    expect(
      stale,
      stale.length
        ? `apps/panel-client/src/locales/en/installProgress.json has entries for removed/renamed codes: ${stale.join(", ")}`
        : "",
    ).toEqual([]);
  });
});
