import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ProgressCode } from "../utils/progressCodes.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(SERVER_DIR, "..", "..");
const SERVER_JS_PATH = path.join(SERVER_DIR, "routes", "server.js");
const EN_LOCALE_PATH = path.join(
  REPO_ROOT,
  "apps/panel-client/src/locales/en/installProgress.json",
);

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
        ? `Found ${unregistered.length} ProgressCode.* reference(s) not in apps/panel-server/utils/progressCodes.ts: ${unregistered.join(", ")}`
        : "",
    ).toEqual([]);
  });

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
