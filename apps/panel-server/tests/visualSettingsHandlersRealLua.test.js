import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-27, five-visual-settings-routes-doa-or-decayed: git log -S across
// every commit in this repo's history (both for the dedicated
// /visual/view-distance|daylight|night-strength|desaturation|ambient route
// paths, and for the bridge action names setViewDistance/setDayLight/
// setNightStrength/setDesaturation/setAmbient themselves, run WITHOUT a
// leading slash per the Git Bash pickaxe hazard) turns up ZERO client
// callers, ever -- DOA, not decayed. Separately, the generic
// getClimateFloat-by-id mechanism (client's setClimateFloat/getClimateFloats,
// which the Events.tsx climate panel DOES use for six OTHER float ids --
// 3/4/5/6/8/12) has also never included these five ids (0/2/9/10/11) at any
// point in history -- confirmed the same way.
//
// THIS FILE ANSWERS THE SEPARATE QUESTION: if these five routes WERE called,
// would the handler do something real, or is it broken/stubbed? Executes the
// actual integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua source under
// fengari (a real Lua 5.3 VM, not a hand-read of the file) against a
// ClimateManager stub shaped exactly like the one handlers.getClimateFloats
// itself already probes for these same five float ids (see that handler's
// own floatIds table: 0=FLOAT_DESATURATION, 2=FLOAT_NIGHT_STRENGTH,
// 9=FLOAT_AMBIENT, 10=FLOAT_VIEW_DISTANCE, 11=FLOAT_DAYLIGHT_STRENGTH) --
// proving each handler reaches the real
// getClimateFloat(id):setEnableAdmin(true):setAdminValue(value) chain, the
// same primary code path the three currently-reachable sibling handlers
// (setWind/setFog/setClouds, live via Events.tsx's climate panel) use for
// their own float ids. Per panelBridgeHandlerVerifyEnforcement.test.js, the
// success claim's ceiling today is "the call didn't throw" -- a PROVISIONAL,
// already-tracked gap shared by ~15 other handlers including those live
// siblings, not something unique to these five or introduced by their lack
// of a caller.

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
