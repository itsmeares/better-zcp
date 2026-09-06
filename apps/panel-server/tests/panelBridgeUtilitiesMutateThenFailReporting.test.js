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
    expect(result.data.hydroPowerOn).toBe(false);
    expect(Array.isArray(result.data.debug)).toBe(true);
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
