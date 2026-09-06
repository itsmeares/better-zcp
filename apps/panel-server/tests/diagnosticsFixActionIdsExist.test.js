import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(SERVER_DIR, "..", "..");
const DEBUG_JS_PATH = path.join(SERVER_DIR, "routes", "debug.js");
const DEBUG_TSX_PATH = path.join(
  REPO_ROOT,
  "apps/panel-client/src/pages/Debug.tsx",
);

// The integrity property this file exists to protect (named explicitly in
// the diagnostics-autofix-2026-08-30 card): every `case "..."` in
// getDiagnosticsFixAction and getRequiredCapabilityForCheck must reference
// a check id GET /api/debug/diagnostics can actually emit. It's easy to
// break -- add a case for an id you assumed existed, typo an id while
// splitting a shared case into two, or rename a server-side id without
// updating its client-side case -- and nothing else catches it: a stale
// case id doesn't throw, it just silently never matches, so the fix button
// for that check quietly falls back to the generic (and possibly wrong)
// `default` case forever.
//
// Same extraction approach as diagnosticsCheckRegistry.test.js (regex over
// the GET /diagnostics handler's own source range, not a full parse) --
// reused rather than duplicated with different bugs.
function extractDiagnosticsCheckIds(source) {
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
  const CALL_RE = /diag(?:Ok|Fail|Warn|Skip|Info)\(\s*"([^"]+)"/g;
  const ids = new Set();
  let m;
  while ((m = CALL_RE.exec(handlerSource))) ids.add(m[1]);
  return ids;
}

// getDiagnosticsFixAction is ALSO called for the World Map tab's own check
// list (a different endpoint, GET /api/debug/worldmap, scanned and
// enforced separately by worldMapCheckRegistry.test.js) -- so a handful of
// case ids in the switch are real, just not reachable from GET
// /diagnostics. Each entry here must be paired with the sibling id that
// case shares a body with, so this allowlist can't silently grow into a
// dumping ground for genuine typos -- add one only alongside a code
// comment at the case site explaining which OTHER endpoint owns it.
const KNOWN_NON_DIAGNOSTICS_IDS = new Set([
  "worldmap.bridge.configured", // shares a case with "bridge.configured"; real id, owned by GET /worldmap
]);

function extractSwitchCaseIds(source, functionStartMarker, functionEndMarker) {
  const start = source.indexOf(functionStartMarker);
  if (start === -1) {
    throw new Error(
      `Could not find "${functionStartMarker}" in Debug.tsx -- has it been renamed?`,
    );
  }
  const end = functionEndMarker
    ? source.indexOf(functionEndMarker, start)
    : source.length;
  if (functionEndMarker && end === -1) {
    throw new Error(
      `Could not find "${functionEndMarker}" in Debug.tsx after "${functionStartMarker}" -- has it moved or been renamed?`,
    );
  }
  const body = source.slice(start, end);
  const CASE_RE = /case\s+"([a-zA-Z][a-zA-Z0-9_.]*)"\s*:/g;
  const ids = new Set();
  let m;
  while ((m = CASE_RE.exec(body))) ids.add(m[1]);
  return ids;
}

const debugJsSource = fs.readFileSync(DEBUG_JS_PATH, "utf8");
const debugTsxSource = fs.readFileSync(DEBUG_TSX_PATH, "utf8");
const diagnosticsCheckIds = extractDiagnosticsCheckIds(debugJsSource);

describe("Debug.tsx fix-action switches only reference real check ids (self-enforcing)", () => {
  it("sanity check on the scan itself -- found known real ids", () => {
    // If this fails, the regex/boundary scan broke, not the switches below --
    // fix the extraction helpers before trusting anything else in this file.
    expect(diagnosticsCheckIds.has("server.process")).toBe(true);
    expect(diagnosticsCheckIds.has("db.writable")).toBe(true);
    expect(diagnosticsCheckIds.size).toBeGreaterThan(30);
  });

  it("every case in getDiagnosticsFixAction references a real check id (or a documented non-/diagnostics one)", () => {
    const caseIds = extractSwitchCaseIds(
      debugTsxSource,
      "export function getDiagnosticsFixAction",
      "export function getRequiredCapabilityForCheck",
    );
    const stale = [...caseIds].filter(
      (id) => !diagnosticsCheckIds.has(id) && !KNOWN_NON_DIAGNOSTICS_IDS.has(id),
    );
    expect(
      stale,
      stale.length
        ? `getDiagnosticsFixAction has a case for an id GET /api/debug/diagnostics never emits: ${stale.join(", ")}. ` +
            `Renamed, removed, or typo'd -- fix the case, or if it's a real id owned by a different endpoint, add it to KNOWN_NON_DIAGNOSTICS_IDS with a comment explaining why.`
        : "",
    ).toEqual([]);
  });

  it("every case in getRequiredCapabilityForCheck references a real check id (or a documented non-/diagnostics one)", () => {
    const caseIds = extractSwitchCaseIds(
      debugTsxSource,
      "export function getRequiredCapabilityForCheck",
      "const DebugPerformanceCharts",
    );
    const stale = [...caseIds].filter(
      (id) => !diagnosticsCheckIds.has(id) && !KNOWN_NON_DIAGNOSTICS_IDS.has(id),
    );
    expect(
      stale,
      stale.length
        ? `getRequiredCapabilityForCheck has a case for an id GET /api/debug/diagnostics never emits: ${stale.join(", ")}.`
        : "",
    ).toEqual([]);
  });

  it("every case id in getRequiredCapabilityForCheck is also a case in getDiagnosticsFixAction (no orphaned capability entry)", () => {
    const fixActionIds = extractSwitchCaseIds(
      debugTsxSource,
      "export function getDiagnosticsFixAction",
      "export function getRequiredCapabilityForCheck",
    );
    const capabilityIds = extractSwitchCaseIds(
      debugTsxSource,
      "export function getRequiredCapabilityForCheck",
      "const DebugPerformanceCharts",
    );
    const orphaned = [...capabilityIds].filter((id) => !fixActionIds.has(id));
    expect(
      orphaned,
      orphaned.length
        ? `getRequiredCapabilityForCheck names a capability for an id with no matching case in getDiagnosticsFixAction: ${orphaned.join(", ")}.`
        : "",
    ).toEqual([]);
  });
});
