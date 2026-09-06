import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-31 bug hunt (PanelBridge Lua mod + bridge protocol), god's ruling:
// handlers.runEventSequence pcall-wraps and honestly records each chained
// step's own success/error into a per-step `results` array, but its OWN
// top-level return used to be a hardcoded `return true, {...results...}` --
// regardless of whether any step actually succeeded. A batch where every
// step failed still reported ok=true. apps/panel-client/src/pages/Events.tsx's
// BridgeResultDisplay gates its "Operation Failed" card purely on that
// top-level flag and has no special-case renderer for this handler, so an
// operator running a fully-failed sequence saw a plain green success card
// -- the real per-step failures were only reachable by manually expanding
// raw JSON.
//
// This was also the site of a false rationale in the audit's own meta-test
// (panelBridgeHandlerVerifyEnforcement.test.js's CANNOT_VERIFY_OR_EQUIVALENT
// allowlist), which claimed this handler "returns THEIR (ok,data,err)
// results directly" -- it did not; it wrapped every outcome in the same
// hardcoded true. That entry has been removed (not rewritten) so the
// handler is genuinely covered by the meta-test going forward.
//
// Ruling: ok = (no step failed), not "only when all fail" -- a sequence
// reporting true on partial completion is the same shape as the two other
// "ran vs succeeded" fixes tonight. failedCount is exposed alongside the
// unchanged `results` array so a caller can tell 9-of-10 from 0-of-10
// without parsing it. The full `results` array must still be present on
// the failure branch too (nothing about "some steps failed" should make
// the caller lose the ones that DID succeed).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',  'integrations', 'panelbridge',
  'PanelBridge',
  'media',
  'lua',
  'server',
  'PanelBridge.lua',
);

// Minimal stub: real enough that stopWeather (a "weather" step with
// weatherType "stop") succeeds without throwing, with none of the rest of
// the climate/weather surface stubbed out.
const STUBS = `
FakeClimateManager = {}
function FakeClimateManager:stopWeatherAndThunder() return true end
getClimateManager = function() return FakeClimateManager end
`;

describe('PanelBridge.lua runEventSequence -- ok reflects whether every step actually succeeded', () => {
  it('reports ok=true when every step succeeds (unchanged happy path)', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('runEventSequence', {
      steps: [
        { kind: 'weather', weatherType: 'stop' },
        { kind: 'weather', weatherType: 'stop' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.data.failedCount).toBe(0);
    expect(result.data.executed).toBe(2);
    expect(result.data.results).toHaveLength(2);
    expect(result.data.results.every((r) => r.success)).toBe(true);
  });

  it('reports ok=false when every step fails -- the exact bug this fixes', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('runEventSequence', {
      steps: [
        { kind: 'bogus-unsupported-kind' },
        { kind: 'bogus-unsupported-kind' },
      ],
    });

    expect(result.ok).toBe(false);
    // Even on the failure branch, the full per-step detail must still reach
    // the caller -- this is what lets an operator (or the UI, once it grows
    // a real renderer) see exactly what happened, not just that it did.
    expect(result.data.failedCount).toBe(2);
    expect(result.data.executed).toBe(2);
    expect(result.data.results).toHaveLength(2);
    expect(result.data.results.every((r) => r.success === false)).toBe(true);
  });

  it('reports ok=false on a PARTIAL failure too -- ok means "no step failed", not "not every step failed"', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('runEventSequence', {
      steps: [
        { kind: 'weather', weatherType: 'stop' }, // succeeds
        { kind: 'bogus-unsupported-kind' }, // fails
        { kind: 'weather', weatherType: 'stop' }, // succeeds
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.data.failedCount).toBe(1);
    expect(result.data.executed).toBe(3);
    // The two that DID succeed must still be reported as such -- a partial
    // failure must not be reported as if nothing worked either.
    expect(result.data.results.filter((r) => r.success)).toHaveLength(2);
    expect(result.data.results.filter((r) => !r.success)).toHaveLength(1);
  });
});
