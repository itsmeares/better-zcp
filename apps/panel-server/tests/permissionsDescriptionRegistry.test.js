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

function normalizeDashes(value) {
  return value.replace(/--/g, "—");
}

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
      if (localeDesc === undefined) continue;
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
