import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  levenshteinDistance,
  findNearMissTypo,
  triageUnresolvedMods,
} from "../routes/debug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(SERVER_DIR, "..", "..");
const DEBUG_JS_PATH = path.join(SERVER_DIR, "routes", "debug.js");
const EN_DEBUG_JSON_PATH = path.join(REPO_ROOT, "apps/panel-client/src/locales/en/debug.json");
const FR_DEBUG_JSON_PATH = path.join(REPO_ROOT, "apps/panel-client/src/locales/fr/debug.json");

const STATUS_NAMES = new Set(["ok", "fail", "warn", "skip", "info"]);

const KNOWN_TRANSLATED_IDS = new Set([
  // Batch 1: Core Services
  "server.process",
  "rcon.connected",
  "modChecker",
  "scheduler",
  "discord.bot",
  "services.error",
  // Batch 2: Active Server
  "server.active",
  "server.installPath",
  "server.zomboidData",
  "server.startScript",
  "server.jre",
  "server.ini",
  "server.rconPassword",
  "server.bridgeMod",
  // Batch 3: Storage & Database
  "db.exists",
  "db.writable",
  "db.backup",
  "logs.writable",
  "disk.free",
  "storage.saveSize",
  "storage.error",
  // Batch 4: Runtime & Memory
  "runtime.heap",
  "runtime.hostMem",
  "runtime.uptime",
  "runtime.error",
  "runtime.timeSkew",
  // Batch 5: Updates
  "update.steamApi",
  "update.panel",
  "update.mods",
  "updates.error",
  // Batch 6: PanelBridge IPC
  "bridge.configured",
  "bridge.writable",
  "bridge.heartbeat",
  "bridge.error",
  // Batch 7: Mods (+ server.recentCrash, same try-block as batch 2's
  // Active Server checks, just further down in the file)
  "mods.workshopCrash",
  "server.recentCrash",
  "mods.numericInMods",
  "mods.resolved",
  "mods.orphanWorkshop",
  "mods.duplicates",
  "mods.maps",
  // Batch 8 (final): remaining server.* catch-alls, same try-block again.
  // server.configDrift is DELIBERATELY NOT in this list -- its message is
  // built by joining a variable-length array of independently-phrased
  // clauses (up to 3 possible drift dimensions), which doesn't fit the
  // params/variant mechanism without a wire-shape change (structured
  // clauses instead of one joined string). Left on the English fallback,
  // unchanged from before this file existed -- not a regression, a
  // deliberately deferred id. See the wind-down report for the full reasoning.
  "server.sandboxCorrupt",
  "server.sandboxVars",
  "server.staleLocks",
  "server.jreWorks",
  "server.error",
]);

function extractDiagnosticsChecks(source) {
  const startMarker = 'router.get("/diagnostics"';
  const endMarker = 'router.get("/worldmap"';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(
      "Could not locate the GET /diagnostics ... GET /worldmap boundaries in debug.js -- " +
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
        `Found a variant: "${v.variant}" literal in the /diagnostics handler with no preceding ` +
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

function flattenLocaleChecks(checksNode) {
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

  walk(checksNode, []);
  return { plain, withVariant };
}

function loadChecksNode(localePath) {
  const raw = JSON.parse(fs.readFileSync(localePath, "utf8"));
  const checks = { ...(raw?.diagnostics?.checks ?? {}) };
  delete checks.worldmap;
  return checks;
}

const debugJsSource = fs.readFileSync(DEBUG_JS_PATH, "utf8");
const source = extractDiagnosticsChecks(debugJsSource);
const en = flattenLocaleChecks(loadChecksNode(EN_DEBUG_JSON_PATH));
const fr = flattenLocaleChecks(loadChecksNode(FR_DEBUG_JSON_PATH));

describe("diagnostics check locale registry (self-enforcing, mirrors errorCodeRegistry.test.js)", () => {
  it("found at least the checks batches 1 and 2 are known to have added (sanity check on the scan itself)", () => {
    expect(source.plain.has("server.process::ok")).toBe(true);
    expect(source.withVariant.has("server.installPath::fail::netMount")).toBe(true);
    expect(source.withVariant.has("server.jre::warn::linux")).toBe(true);
  });

  for (const id of KNOWN_TRANSLATED_IDS) {
    describe(`"${id}" (in KNOWN_TRANSLATED_IDS)`, () => {
      const plainForId = [...source.plain].filter((key) => key.startsWith(`${id}::`));
      const variantForId = [...source.withVariant].filter((key) => key.startsWith(`${id}::`));

      if (plainForId.length === 0 && variantForId.length === 0) {
        it("was found in the /diagnostics handler at all", () => {
          throw new Error(
            `KNOWN_TRANSLATED_IDS lists "${id}" but no diagOk/diagFail/diagWarn/diagSkip/diagInfo ` +
              `call for it was found in the /diagnostics handler -- renamed, removed, or the id ` +
              `string in source no longer matches. Update KNOWN_TRANSLATED_IDS or the source.`,
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
    it("every en debug.json diagnostics.checks entry (plain) still exists in the handler", () => {
      const stale = [...en.plain.keys()].filter((key) => !source.plain.has(key));
      expect(stale, `stale en entries: ${stale.join(", ")}`).toEqual([]);
    });
    it("every en debug.json diagnostics.checks entry (variant) still exists in the handler", () => {
      const stale = [...en.withVariant.keys()].filter((key) => !source.withVariant.has(key));
      expect(stale, `stale en variant entries: ${stale.join(", ")}`).toEqual([]);
    });
    it("every fr debug.json diagnostics.checks entry (plain) still exists in the handler", () => {
      const stale = [...fr.plain.keys()].filter((key) => !source.plain.has(key));
      expect(stale, `stale fr entries: ${stale.join(", ")}`).toEqual([]);
    });
    it("every fr debug.json diagnostics.checks entry (variant) still exists in the handler", () => {
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

describe("triageUnresolvedMods (mods.resolved per-ID triage)", () => {
  describe("levenshteinDistance", () => {
    it("is 0 for identical strings and the length for one empty string", () => {
      expect(levenshteinDistance("abc", "abc")).toBe(0);
      expect(levenshteinDistance("", "abc")).toBe(3);
      expect(levenshteinDistance("abc", "")).toBe(3);
    });
    it("counts a single substitution as distance 1", () => {
      expect(levenshteinDistance("Footprint", "Footprant")).toBe(1);
    });
  });

  describe("findNearMissTypo", () => {
    it("finds a one-character typo of an installed mod ID", () => {
      expect(findNearMissTypo("Footprnt", ["Footprint", "OtherMod"])).toBe(
        "Footprint",
      );
    });
    it("treats a pure case difference as a match", () => {
      expect(
        findNearMissTypo("quartermaster", ["Quartermaster", "OtherMod"]),
      ).toBe("Quartermaster");
    });
    it("does not match an installed ID that's merely similar-length but unrelated", () => {
      expect(findNearMissTypo("Quartermaster", ["Footprint"])).toBeNull();
    });
    it("scales its threshold with ID length so a single slip in a long ID still counts as near", () => {
      expect(
        findNearMissTypo("RepairAnyClothesSearchModeAPI42", [
          "RepairAnyClothesSearchModeAPI41",
        ]),
      ).toBe("RepairAnyClothesSearchModeAPI41");
    });
    it("returns null when the ID isn't close to anything installed", () => {
      expect(findNearMissTypo("TotallyUnrelatedModId", ["Footprint"])).toBeNull();
    });
  });

  describe("triageUnresolvedMods", () => {
    it("classifies a near-miss typo even while a Steam operation is active (typo wins)", () => {
      const result = triageUnresolvedMods(
        ["Footprnt"],
        ["Footprint"],
        { steamOperationActive: true, anyWorkshopMissingFromDisk: true },
      );
      expect(result).toEqual([
        { modId: "Footprnt", cause: "typo", suggestion: "Footprint" },
      ]);
    });
    it("classifies stillDownloading when a Steam operation is active and there's no typo match", () => {
      const result = triageUnresolvedMods(
        ["Quartermaster"],
        ["SomeOtherMod"],
        { steamOperationActive: true, anyWorkshopMissingFromDisk: false },
      );
      expect(result).toEqual([
        { modId: "Quartermaster", cause: "stillDownloading" },
      ]);
    });
    it("classifies workshopNotOnDisk when nothing is downloading but a WorkshopItems= folder is missing", () => {
      const result = triageUnresolvedMods(
        ["RepairAnyClothesSearchModeAPI41"],
        ["SomeOtherMod"],
        { steamOperationActive: false, anyWorkshopMissingFromDisk: true },
      );
      expect(result).toEqual([
        {
          modId: "RepairAnyClothesSearchModeAPI41",
          cause: "workshopNotOnDisk",
        },
      ]);
    });
    it("classifies absent when there's no typo, no active download, and nothing missing from disk", () => {
      const result = triageUnresolvedMods(
        ["TotallyMadeUpModId"],
        ["SomeOtherMod"],
        { steamOperationActive: false, anyWorkshopMissingFromDisk: false },
      );
      expect(result).toEqual([{ modId: "TotallyMadeUpModId", cause: "absent" }]);
    });
  });
});
