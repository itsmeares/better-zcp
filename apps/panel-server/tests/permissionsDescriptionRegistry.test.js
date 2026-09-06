import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CAPABILITIES } from "../services/permissions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLES_EN_PATH = path.join(
  __dirname,
  "..",
  "..",
  "panel-client",
  "src",
  "locales",
  "en",
  "roles.json",
);

// RolesPermissions.tsx renders `t('capabilities.<key>.description', { defaultValue:
// cap.description })` -- the locale key, when present, SHADOWS the server string
// entirely rather than falling back to it. That means these are two independent
// sources of truth for the same fact (what a permission actually grants), and
// nothing before this test noticed when they drifted: bridge.diagnostics' server
// description was corrected on 2026-08-27 (commit d490410) to stop promising
// unreachable debug-log/stats access, and the fix was invisible in the UI until
// en/roles.json was updated separately, in the same conversation, because nothing
// enforced the two staying in sync. This test is that enforcement.
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

// permissions.js types every dash as portable ASCII ("--"); several locale
// entries (predating this test) instead use a real typographic em dash ("—",
// U+2014) for the same clause -- same meaning, different character. Normalize
// only this one substitution before comparing, so the check stays sensitive to
// actual content drift without flattening the locale's nicer typography back
// to ASCII, or permanently allowlisting half a dozen near-duplicate strings
// for a difference that was never about meaning.
function normalizeDashes(value) {
  return value.replace(/--/g, "—");
}

// Real, reported content differences (not punctuation) between the server
// description and the en locale -- each is a genuine judgement call about
// which side is right (or whether to add the missing clause to the locale),
// deliberately left to a human rather than auto-resolved here. See conv
// bug-hunt-2026-08-26 (reported 2026-08-27) for the write-up. Remove an entry
// the moment it's resolved, in either direction -- this allowlist existing at
// all is itself a thing worth noticing, not a permanent home for drift.
//
// Empty as of 2026-08-27: diagnostics.manage was the one entry here (server
// described relocating data/log directories, en/roles.json didn't), resolved
// in the same pass that also dropped diagnostics.manage's "database
// maintenance tools" clause (POST/GET /api/debug/database* -- zero client
// callers, same wholly-unreachable shape as bridge.diagnostics' debug-log/
// stats promise).
const KNOWN_CONTENT_DIVERGENCES = new Map([]);

describe("permission capability descriptions: apps/panel-server/services/permissions.js vs apps/panel-client/src/locales/en/roles.json", () => {
  const roles = JSON.parse(fs.readFileSync(ROLES_EN_PATH, "utf8"));
  const localeDescriptions = flattenCapabilityDescriptions(roles.capabilities);
  const serverDescriptions = new Map(CAPABILITIES.map((c) => [c.key, c.description]));

  it("sanity check: found a non-trivial number of capabilities on both sides (guards against a silently-empty parse)", () => {
    expect(CAPABILITIES.length).toBeGreaterThan(20);
    expect(Object.keys(localeDescriptions).length).toBeGreaterThan(20);
  });

  it("every capability in permissions.js has a matching en/roles.json entry", () => {
    const missing = CAPABILITIES.map((c) => c.key).filter(
      (key) => !(key in localeDescriptions),
    );
    expect(
      missing,
      missing.length
        ? `apps/panel-client/src/locales/en/roles.json is missing a capabilities entry for: ${missing.join(", ")}`
        : "",
    ).toEqual([]);
  });

  it("every en/roles.json capability entry is a registered capability (no stale keys for a removed/renamed one)", () => {
    const stale = Object.keys(localeDescriptions).filter(
      (key) => !serverDescriptions.has(key),
    );
    expect(
      stale,
      stale.length
        ? `apps/panel-client/src/locales/en/roles.json has capabilities entries for unknown key(s): ${stale.join(", ")}`
        : "",
    ).toEqual([]);
  });

  it("descriptions match server<->locale (modulo the ASCII-dash/em-dash typographic difference), except the documented content divergences above", () => {
    const mismatches = [];
    for (const [key, serverDesc] of serverDescriptions) {
      if (KNOWN_CONTENT_DIVERGENCES.has(key)) continue;
      const localeDesc = localeDescriptions[key];
      if (localeDesc === undefined) continue; // already reported by the missing-entry test above
      if (normalizeDashes(serverDesc) !== localeDesc) {
        mismatches.push({ key, serverDesc, localeDesc });
      }
    }
    expect(
      mismatches,
      mismatches.length
        ? mismatches
            .map((m) => `${m.key}:\n  server: ${m.serverDesc}\n  locale: ${m.localeDesc}`)
            .join("\n\n")
        : "",
    ).toEqual([]);
  });
});
