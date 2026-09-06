import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(SERVER_DIR, "..", "..");
const DEBUG_JS_PATH = path.join(SERVER_DIR, "routes", "debug.js");
const EN_DEBUG_JSON_PATH = path.join(REPO_ROOT, "apps/panel-client/src/locales/en/debug.json");
const FR_DEBUG_JSON_PATH = path.join(REPO_ROOT, "apps/panel-client/src/locales/fr/debug.json");

const STATUS_NAMES = new Set(["ok", "fail", "warn", "skip", "info"]);

const KNOWN_TRANSLATED_IDS = new Set([
  // Batch 1: tile CDNs, runtime guard, tile-probe error, static bridge states
  "worldmap.activeServer",
  "worldmap.tiles.b42",
  "worldmap.tiles.b41",
  "worldmap.tiles.b42Top",
  "worldmap.tiles.buildDetect",
  "worldmap.tiles.error",
  "worldmap.runtime",
  "worldmap.bridge.configured",
  "worldmap.bridge.running",
  "worldmap.bridge.mod",
  // Batch 2 (final): heartbeat + the bare "healthy" state (2-way
  // with/without-heartbeat-clause variant), and save detection
  // (2-way b42/b41 variant + a plain not-detected warn).
  "worldmap.bridge.heartbeat",
  "worldmap.bridge",
  "worldmap.save.none",
  "worldmap.save.build",
  "worldmap.save.dataPath",
]);

function extractWorldMapChecks(source) {
  const startMarker = 'router.get("/worldmap"';
  const endMarker = 'router.get("/performance-history"';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(
      "Could not locate the GET /worldmap ... GET /performance-history boundaries in debug.js -- " +
        "this test's scan range depends on both route registrations staying literal strings.",
    );
  }
  const handlerSource = source.slice(start, end);

  const CALL_RE = /diag(Ok|Fail|Warn|Skip|Info)\(\s*"([^"]+)"/g;
  const calls = [];
  let m;
  while ((m = CALL_RE.exec(handlerSource))) {
    calls.push({ index: m.index, status: m[1].toLowerCase(), id: m[2] });
  }

  const VARIANT_RE = /variant:\s*"([^"]+)"/g;
  const variantOccurrences = [];
  while ((m = VARIANT_RE.exec(handlerSource))) {
    variantOccurrences.push({ index: m.index, variant: m[1] });
  }

  const callIndicesWithVariant = new Set();
  const withVariant = new Set();
  for (const v of variantOccurrences) {
    let owner = null;
    for (const call of calls) {
      if (call.index <= v.index && (!owner || call.index > owner.index)) owner = call;
    }
    if (!owner) {
      throw new Error(
        `Found a variant: "${v.variant}" literal in the /worldmap handler with no preceding ` +
          `diagOk/diagFail/diagWarn/diagSkip/diagInfo call to attach it to (offset ${v.index}).`,
      );
    }
    callIndicesWithVariant.add(owner.index);
    withVariant.add(`${owner.id}::${owner.status}::${v.variant}`);
  }

  const plain = new Set();
  for (const call of calls) {
    if (!callIndicesWithVariant.has(call.index)) {
      plain.add(`${call.id}::${call.status}`);
    }
  }

  return { plain, withVariant };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function looksLikeCheckLeaf(node) {
  return (
    node &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    (typeof node.label === "string" || typeof node.message === "string")
  );
}

function flattenWorldMapLocaleChecks(worldmapNode) {
  const plain = new Map();
  const withVariant = new Map();

  function walk(node, idSegments) {
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;

      if (STATUS_NAMES.has(key)) {
        const id = idSegments.join(".");
        if (looksLikeCheckLeaf(value)) {
          plain.set(`${id}::${key}`, value);
        }
        for (const [variantKey, variantValue] of Object.entries(value)) {
          if (variantKey === "label" || variantKey === "message" || variantKey === "hint") continue;
          if (looksLikeCheckLeaf(variantValue)) {
            withVariant.set(`${id}::${key}::${variantKey}`, variantValue);
          }
        }
      } else {
        walk(value, [...idSegments, key]);
      }
    }
  }

  walk(worldmapNode, ["worldmap"]);
  return { plain, withVariant };
}

function loadWorldMapChecksNode(localePath) {
  const raw = JSON.parse(fs.readFileSync(localePath, "utf8"));
  return raw?.diagnostics?.checks?.worldmap ?? {};
}

const debugJsSource = fs.readFileSync(DEBUG_JS_PATH, "utf8");
const source = extractWorldMapChecks(debugJsSource);
const en = flattenWorldMapLocaleChecks(loadWorldMapChecksNode(EN_DEBUG_JSON_PATH));
const fr = flattenWorldMapLocaleChecks(loadWorldMapChecksNode(FR_DEBUG_JSON_PATH));

describe("world map check locale registry (self-enforcing, scoped to GET /worldmap only)", () => {
  it("found at least worldmap.tiles.b42's ok/fail arms and worldmap.save.build's b42 variant (sanity check on the scan itself)", () => {
    expect(source.plain.has("worldmap.tiles.b42::ok")).toBe(true);
    expect(source.plain.has("worldmap.tiles.b42::fail")).toBe(true);
    expect(source.withVariant.has("worldmap.save.build::ok::b42")).toBe(true);
    expect(source.withVariant.has("worldmap.bridge::ok::withHeartbeat")).toBe(true);
  });

  for (const id of KNOWN_TRANSLATED_IDS) {
    describe(`"${id}" (in KNOWN_TRANSLATED_IDS)`, () => {
      const plainForId = [...source.plain].filter((key) => key.startsWith(`${id}::`));
      const variantForId = [...source.withVariant].filter((key) => key.startsWith(`${id}::`));

      if (plainForId.length === 0 && variantForId.length === 0) {
        it("was found in the /worldmap handler at all", () => {
          throw new Error(
            `KNOWN_TRANSLATED_IDS lists "${id}" but no diagOk/diagFail/diagWarn/diagSkip/diagInfo ` +
              `call for it was found in the /worldmap handler -- renamed, removed, or the id string ` +
              `in source no longer matches. Update KNOWN_TRANSLATED_IDS or the source.`,
          );
        });
      }

      for (const key of plainForId) {
        it(`${key} has complete en and fr entries`, () => {
          const enEntry = en.plain.get(key);
          const frEntry = fr.plain.get(key);
          expect(enEntry, `apps/panel-client/src/locales/en/debug.json is missing diagnostics.checks.${key.replace(/::/g, ".")}`).toBeTruthy();
          expect(frEntry, `apps/panel-client/src/locales/fr/debug.json is missing diagnostics.checks.${key.replace(/::/g, ".")}`).toBeTruthy();
          expect(isNonEmptyString(enEntry?.label)).toBe(true);
          expect(isNonEmptyString(enEntry?.message)).toBe(true);
          expect(isNonEmptyString(frEntry?.label)).toBe(true);
          expect(isNonEmptyString(frEntry?.message)).toBe(true);
        });
      }

      for (const key of variantForId) {
        it(`${key} has complete en and fr entries`, () => {
          const enEntry = en.withVariant.get(key);
          const frEntry = fr.withVariant.get(key);
          const dotted = key.replace(/::/g, ".");
          expect(enEntry, `apps/panel-client/src/locales/en/debug.json is missing diagnostics.checks.${dotted}`).toBeTruthy();
          expect(frEntry, `apps/panel-client/src/locales/fr/debug.json is missing diagnostics.checks.${dotted}`).toBeTruthy();
          expect(isNonEmptyString(enEntry?.label)).toBe(true);
          expect(isNonEmptyString(enEntry?.message)).toBe(true);
          expect(isNonEmptyString(frEntry?.label)).toBe(true);
          expect(isNonEmptyString(frEntry?.message)).toBe(true);
        });
      }
    });
  }

  describe("no stale locale entries (check removed or renamed in source, translation left behind)", () => {
    it("every en debug.json diagnostics.checks.worldmap entry (plain) still exists in the handler", () => {
      const stale = [...en.plain.keys()].filter((key) => !source.plain.has(key));
      expect(stale, `stale en entries: ${stale.join(", ")}`).toEqual([]);
    });
    it("every en debug.json diagnostics.checks.worldmap entry (variant) still exists in the handler", () => {
      const stale = [...en.withVariant.keys()].filter((key) => !source.withVariant.has(key));
      expect(stale, `stale en variant entries: ${stale.join(", ")}`).toEqual([]);
    });
    it("every fr debug.json diagnostics.checks.worldmap entry (plain) still exists in the handler", () => {
      const stale = [...fr.plain.keys()].filter((key) => !source.plain.has(key));
      expect(stale, `stale fr entries: ${stale.join(", ")}`).toEqual([]);
    });
    it("every fr debug.json diagnostics.checks.worldmap entry (variant) still exists in the handler", () => {
      const stale = [...fr.withVariant.keys()].filter((key) => !source.withVariant.has(key));
      expect(stale, `stale fr variant entries: ${stale.join(", ")}`).toEqual([]);
    });
  });

  it("en and fr define exactly the same set of plain check entries", () => {
    const enOnly = [...en.plain.keys()].filter((key) => !fr.plain.has(key));
    const frOnly = [...fr.plain.keys()].filter((key) => !en.plain.has(key));
    expect(enOnly, `in en only: ${enOnly.join(", ")}`).toEqual([]);
    expect(frOnly, `in fr only: ${frOnly.join(", ")}`).toEqual([]);
  });

  it("en and fr define exactly the same set of variant check entries", () => {
    const enOnly = [...en.withVariant.keys()].filter((key) => !fr.withVariant.has(key));
    const frOnly = [...fr.withVariant.keys()].filter((key) => !en.withVariant.has(key));
    expect(enOnly, `in en only: ${enOnly.join(", ")}`).toEqual([]);
    expect(frOnly, `in fr only: ${frOnly.join(", ")}`).toEqual([]);
  });
});
