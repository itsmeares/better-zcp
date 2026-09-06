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

/**
 * Self-enforcing registry test for GET /worldmap's checks -- the sibling of
 * apps/panel-server/tests/diagnosticsCheckRegistry.test.js, scoped to worldmap.* ids
 * only. GET /worldmap is its own route handler (apps/panel-server/routes/debug.js,
 * immediately after GET /diagnostics) with its own checks array -- it does
 * NOT inherit diagnosticsCheckRegistry.test.js's coverage. That file's own
 * scan range explicitly stops at `router.get("/worldmap"` and says so.
 * Both files share the SAME locale tree (apps/panel-client/src/locales/{en,fr}/
 * debug.json's diagnostics.checks -- translateDiagnosticCheck() hardcodes
 * that namespace/prefix for every check id, worldmap.* included, so there
 * is no separate worldMap.json to translate into) but each enforces its own
 * id set independently, so a check added to one route can never silently
 * ride on the other route's coverage.
 *
 * ─── THE PARAMS-VS-VARIANT RULE (written down centrally, finally) ─────────
 * This question was answered ad hoc, per check, across all 47 ids in the
 * original /diagnostics effort, and never stated in one place until now:
 *
 *   Does this check need TWO DIFFERENT SENTENCES, or ONE sentence with a
 *   hole to fill?
 *
 *   - One sentence, a hole to fill (a number, a path, a build id, an
 *     already-known-safe technical token) -> `params`. The server attaches
 *     `params: { ... }` next to the check; the client's translated locale
 *     template has a matching `{{placeholder}}`; if any required
 *     placeholder is missing or the wrong type, the client falls back to
 *     the server's raw English text -- it never renders a bare
 *     `{{placeholder}}` to the user.
 *   - Two (or more) genuinely different sentences -- different wording,
 *     different clauses, a different explanation of the SAME status for
 *     the SAME id depending on which branch fired -- -> `variant`, a
 *     literal string segment inserted into the locale key path
 *     (`diagnostics.checks.<id>.<status>.<variant>.<field>`). A variant
 *     entry is always COMPLETE and self-contained (its own label + message
 *     + hint if that status has one) -- never a partial override that falls
 *     back to a plain sibling entry for a field it omits. That keeps the
 *     id+status+variant space exhaustively enumerable for this test: every
 *     combination the handler can emit either has a full locale entry or it
 *     doesn't, no "depends which field" ambiguity to also encode here.
 *
 *   A rule of thumb for the boundary: if the English sentence represents a
 *   distinction with ONE substitutable word (a direction, a state, a
 *   comparison -- "ahead"/"behind", "linux"/"windows"), that is NOT
 *   evidence a single word belongs in that slot in every language. French
 *   in particular often needs a genuine word-order/structural difference
 *   ("a {{skew}} d'avance sur" vs "a {{skew}} de retard sur"), not a
 *   substituted word -- whenever a param would substitute a WORD rather
 *   than a VALUE, suspect it should really be a variant.
 *
 *   Arbitrary/uncontrolled runtime text (a caught exception's `.message`,
 *   an upstream fetch error) is the one accepted exception: it's opaque by
 *   nature (cannot be exhaustively enumerated, so it cannot be a variant)
 *   and is passed as a single params value (see `reason`/`detail` below),
 *   matching the precedent already shipped for server.error/services.error/
 *   etc in the main diagnostics tree -- some untranslated English may leak
 *   through in that one slot, a known and accepted limitation, not a new
 *   one introduced here.
 *
 * ─── THE COMPUTED-VARIANT TRAP (three spellings, watch for all three) ─────
 * A COMPUTED variant is invisible to VARIANT_RE below BY DESIGN (it only
 * matches a literal `variant: "..."` string), and has shown up in three
 * different spellings across this project so far:
 *   1. A ternary:            variant: isLinux ? "linux" : "windows"
 *   2. A template literal:   variant: `${direction}_${platform}`
 *   3. Trusting a shared LABEL instead of the actual call site -- two
 *      genuinely different messages can share identical English label text
 *      (e.g. db.backup's "Backup status unknown" for both an unreadable
 *      directory and a catch-all exception), so grouping by (id, status,
 *      label) instead of by call site silently collapses two entries into
 *      one.
 * All three are fixed the same way: write out separate if/else branches,
 * each with its own literal `variant: "..."` string, and verify by grepping
 * every diagOk/diagFail/diagWarn/diagSkip/diagInfo call for a given id
 * BEFORE writing any locale JSON.
 */
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

/**
 * Scans the GET /worldmap handler ONLY (not the preceding GET /diagnostics
 * handler, which diagnosticsCheckRegistry.test.js already owns) for every
 * diagOk/diagFail/diagWarn/diagSkip/diagInfo call and every literal
 * `variant: "..."` alongside one. Same regex/positional approach as
 * diagnosticsCheckRegistry.test.js's extractDiagnosticsChecks -- see that
 * file's header for why a full parser isn't used here either.
 */
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
  const withVariant = new Set(); // "id::status::variant"
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

  const plain = new Set(); // "id::status"
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

/**
 * Flattens debug.json's diagnostics.checks.worldmap subtree back into the
 * same "id::status" / "id::status::variant" shape extractWorldMapChecks()
 * produces, so the two can be diffed directly in both directions. Only the
 * worldmap.* branch is walked -- every id produced starts with "worldmap."
 * (idSegments is seeded with ["worldmap"]), so this test cannot see or be
 * fooled by the sibling checks under the other top-level categories
 * (server, mods, runtime, ...) that diagnosticsCheckRegistry.test.js owns.
 */
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
    // If this fails, the regex/boundary scan broke, not the translations --
    // fix extractWorldMapChecks() before trusting any other test below.
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

  // Unconditional in both directions, same as diagnosticsCheckRegistry.test.js:
  // a stale locale entry (check removed/renamed in source) is stale regardless
  // of whether its id was ever formally added to KNOWN_TRANSLATED_IDS.
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
