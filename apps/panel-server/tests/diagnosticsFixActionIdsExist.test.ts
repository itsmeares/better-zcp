import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(SERVER_DIR, "..", "..");
const DEBUG_TS_PATH = path.join(SERVER_DIR, "routes", "debug.ts");
const DEBUG_TSX_PATH = path.join(
  REPO_ROOT,
  "apps/panel-client/src/pages/Debug.tsx",
);

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

const debugTsSource = fs.readFileSync(DEBUG_TS_PATH, "utf8");
const debugTsxSource = fs.readFileSync(DEBUG_TSX_PATH, "utf8");
const diagnosticsCheckIds = extractDiagnosticsCheckIds(debugTsSource);

describe("Debug.tsx fix-action switches only reference real check ids (self-enforcing)", () => {
  it("sanity check on the scan itself -- found known real ids", () => {
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
