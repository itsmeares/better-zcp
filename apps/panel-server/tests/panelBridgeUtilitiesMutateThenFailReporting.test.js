import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, total-audit batch 3, item 2 (mutate-then-fail) --
// panelbridge-total-audit-2026-08-30. handlers.restoreUtilities/
// shutOffUtilities each wrap their whole mutation sequence (SandboxVars,
// Java sync, world:setHydroPowerOn) in one pcall. A throw partway through
// used to return `false, nil, err` -- discarding debugInfo, which already
// records exactly which steps completed before the throw, and leaving the
// caller with nothing but an error string. Not adding rollback (a retry with
// the same args is idempotent) -- just reporting what already landed, now
// that a failure's data actually reaches the caller (the processResult
// transport fix, 19f56d98).

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

// Minimal stub set (same shape as panelBridgeUtilitiesHydroPowerOnReporting
// .test.js) with getSandboxOptions() returning nil, so the Java-sync step is
// skipped entirely and the only mutation before the simulated throw is the
// SandboxVars assignment -- keeps the RED/GREEN behavior precise and easy to
// reason about.
function stubsWithHydroThrow(initialHydroOn) {
  return `
SandboxVars = {}
GameTime = { getInstance = function() return nil end }
getOnlinePlayers = function() return nil end
getSandboxOptions = function() return nil end
getCell = function() return nil end

FakeWorld = { hydroOn = ${initialHydroOn} }
function FakeWorld:isHydroPowerOn() return self.hydroOn end
function FakeWorld:setHydroPowerOn(v) error("simulated engine failure") end
getWorld = function() return FakeWorld end
`;
}

describe('PanelBridge.lua handlers.restoreUtilities/shutOffUtilities -- a mid-mutation throw reports what already landed', () => {
  it('restoreUtilities: on a throw in setHydroPowerOn, data is not nil -- it carries debug, power/water, and a best-effort hydroPowerOn read', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsWithHydroThrow(false));
    const result = bridge.callHandler('restoreUtilities', { power: true, water: false });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/Failed to restore utilities/);
    expect(result.data).toBeTruthy();
    expect(result.data.power).toBe(true);
    expect(result.data.water).toBe(false);
    // Best-effort read-back still works even though the mutation that would
    // have flipped it threw -- confirms the field reflects reality, not a
    // hardcoded assumption of what should have happened.
    expect(result.data.hydroPowerOn).toBe(false);
    expect(Array.isArray(result.data.debug)).toBe(true);
    // The SandboxVars step (before the throw in step 3) already ran and
    // logged itself -- that record must survive into the failure response.
    expect(result.data.debug.some((line) => line.includes('Lua ElecShut=9(Disabled)'))).toBe(true);
  });

  it('shutOffUtilities: on a throw in setHydroPowerOn, data is not nil -- same shape as restoreUtilities', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsWithHydroThrow(true));
    const result = bridge.callHandler('shutOffUtilities', { power: true, water: false });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/Failed to shut off utilities/);
    expect(result.data).toBeTruthy();
    expect(result.data.power).toBe(true);
    expect(result.data.water).toBe(false);
    expect(result.data.hydroPowerOn).toBe(true);
    expect(Array.isArray(result.data.debug)).toBe(true);
    expect(result.data.debug.some((line) => line.includes('Lua ElecShut=1(Instant)'))).toBe(true);
  });
});
