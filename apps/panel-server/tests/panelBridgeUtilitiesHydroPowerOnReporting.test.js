import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage for another instance of the b376b2c defect family,
// found while auditing every PanelBridge.lua handler for "reports success
// without checking whether the thing it claims to do happened".
//
// handlers.restoreUtilities/shutOffUtilities each compute the REAL power
// state via world:isHydroPowerOn() and log it into their own debug trail
// ("FINAL isHydroPowerOn=..."), but the `hydroPowerOn` field actually
// returned to the caller was a HARDCODED literal (true for restore, false
// for shutoff) -- not that real read-back. If world:setHydroPowerOn()
// silently doesn't stick (the handler's own comments describe exactly this
// risk: "applySettings can re-roll the modifier" / "so it can't be
// overwritten"), the response still claimed the requested state regardless
// of what actually happened.
//
// 2026-08-31 follow-up (bug hunt): that first fix made the `hydroPowerOn`
// DATA field honest, but left `ok` itself hardcoded true regardless of what
// hydroPowerOn actually says -- the two "must NOT claim power is on/off"
// tests below originally still asserted `ok: true` in exactly the scenario
// their own titles say shouldn't be claimed, because nothing gated ok on
// the read-back this file had already computed two lines above it. Fixed
// to gate ok on hydroPowerOn (when power was actually requested); these
// tests now assert what their titles always said they should.

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

function stubsWithHydroBehavior(sticks) {
  return `
SandboxVars = {}
GameTime = { getInstance = function() return nil end }
getOnlinePlayers = function() return nil end
getSandboxOptions = function() return nil end
getCell = function() return nil end

FakeWorld = { hydroOn = false, sticks = ${sticks} }
function FakeWorld:isHydroPowerOn() return self.hydroOn end
function FakeWorld:setHydroPowerOn(v)
  if self.sticks then
    self.hydroOn = v
  end
  -- else: simulate the real-world failure mode the code's own comments
  -- describe -- the write is silently reverted before the final read-back.
end
getWorld = function() return FakeWorld end
`;
}

describe('PanelBridge.lua handlers.restoreUtilities/shutOffUtilities -- hydroPowerOn must reflect the real read-back', () => {
  it('restoreUtilities reports the real (successful) state when setHydroPowerOn actually sticks', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsWithHydroBehavior(true));
    const result = bridge.callHandler('restoreUtilities', { power: true, water: false });

    expect(result.ok).toBe(true);
    expect(result.data.hydroPowerOn).toBe(true);
  });

  it('restoreUtilities must NOT claim power is on when setHydroPowerOn silently fails to stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsWithHydroBehavior(false));
    const result = bridge.callHandler('restoreUtilities', { power: true, water: false });

    // Before the follow-up fix, ok was hardcoded true here regardless of
    // hydroPowerOn -- the exact claim this test's own title says must not
    // happen.
    expect(result.ok).toBe(false);
    expect(result.data.hydroPowerOn).toBe(false);
    expect(result.err).toMatch(/did not take effect/);
  });

  it('shutOffUtilities reports the real (successful) state when setHydroPowerOn actually sticks', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsWithHydroBehavior(true));
    bridge.run('FakeWorld.hydroOn = true');
    const result = bridge.callHandler('shutOffUtilities', { power: true, water: false });

    expect(result.ok).toBe(true);
    expect(result.data.hydroPowerOn).toBe(false);
  });

  it('shutOffUtilities must NOT claim power is off when setHydroPowerOn silently fails to stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsWithHydroBehavior(false));
    bridge.run('FakeWorld.hydroOn = true');
    const result = bridge.callHandler('shutOffUtilities', { power: true, water: false });

    // Before the follow-up fix, ok was hardcoded true here regardless of
    // hydroPowerOn -- the exact claim this test's own title says must not
    // happen.
    expect(result.ok).toBe(false);
    expect(result.data.hydroPowerOn).toBe(true);
    expect(result.err).toMatch(/did not take effect/);
  });
});
