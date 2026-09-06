import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';


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

    expect(result.ok).toBe(false);
    expect(result.data.hydroPowerOn).toBe(true);
    expect(result.err).toMatch(/did not take effect/);
  });
});
