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

function climateManagerStub() {
  return `
CallLog = {}
local ClimateFloat = {}
ClimateFloat.__index = ClimateFloat
function ClimateFloat.new(id)
  return setmetatable({ id = id }, ClimateFloat)
end
function ClimateFloat:setEnableAdmin(v)
  table.insert(CallLog, { method = "setEnableAdmin", id = self.id, value = v })
  return true
end
function ClimateFloat:setAdminValue(v)
  table.insert(CallLog, { method = "setAdminValue", id = self.id, value = v })
  return true
end

local ClimateManager = {}
function ClimateManager:getClimateFloat(id)
  return ClimateFloat.new(id)
end

getClimateManager = function() return ClimateManager end
`;
}

describe('PanelBridge.lua visual-settings handlers -- do something real if called (real Lua source under fengari)', () => {
  const cases = [
    { handler: 'setDayLight', floatId: 11, value: 0.4 },
    { handler: 'setNightStrength', floatId: 2, value: 0.7 },
    { handler: 'setDesaturation', floatId: 0, value: 0.3 },
    { handler: 'setViewDistance', floatId: 10, value: 0.9 },
    { handler: 'setAmbient', floatId: 9, value: 0.6 },
  ];

  for (const { handler, floatId, value } of cases) {
    it(`${handler} reaches getClimateFloat(${floatId}):setEnableAdmin(true):setAdminValue(${value}) -- the exact id getClimateFloats itself already probes`, () => {
      const bridge = loadPanelBridge(LUA_PATH, climateManagerStub());
      const result = bridge.callHandler(handler, { value });

      expect(result.ok).toBe(true);
      expect(bridge.getGlobal('CallLog')).toEqual([
        { method: 'setEnableAdmin', id: floatId, value: true },
        { method: 'setAdminValue', id: floatId, value },
      ]);
    });
  }

  it('reports a real failure, not a false success, when ClimateManager is unavailable', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'getClimateManager = function() return nil end');
    const result = bridge.callHandler('setDayLight', { value: 0.5 });

    expect(result.ok).toBe(false);
    expect(result.err).toBe('ClimateManager not available');
  });
});
