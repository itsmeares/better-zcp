import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, total-audit batch 2, item 1 (the highest of the three
// pcall-boundary-width findings). handlers.getClimateFloats' loop over its
// 13 known ClimateFloat ids had NO pcall protection at all -- not merely a
// wide boundary shared across all 13 (the getWeather/getPlayerDetails
// shape already fixed elsewhere), an absent catch entirely. One float
// object's accessor throwing crashed the WHOLE handler uncaught, straight
// past to the dispatcher's outer pcall as a generic "Handler crashed: ..."
// instead of a clean ok=false -- and took every OTHER float down with it,
// even ones that would have read fine. Events.tsx polls this handler every
// 10s, making it the most-invoked handler this fix touches.

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

function fakeFloat({ id, name, throws = false }) {
  return `
FakeFloat${id} = { name = "${name}" }
function FakeFloat${id}:getName() return self.name end
function FakeFloat${id}:getFinalValue() ${throws ? 'error("simulated engine failure")' : `return 0.5`} end
function FakeFloat${id}:getMin() return 0 end
function FakeFloat${id}:getMax() return 1 end
function FakeFloat${id}:isEnableAdmin() return false end
`;
}

function climateStub(brokenIds) {
  const allIds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const decls = allIds.map((id) => fakeFloat({ id, name: `Float${id}`, throws: brokenIds.includes(id) })).join('\n');
  return `
${decls}
FakeClimate = {}
function FakeClimate:getClimateFloat(id)
  local floats = { ${allIds.map((id) => `[${id}] = FakeFloat${id}`).join(', ')} }
  return floats[id]
end
getClimateManager = function() return FakeClimate end
`;
}

describe('PanelBridge.lua handlers.getClimateFloats -- one throwing float no longer crashes the whole handler', () => {
  it('all 13 floats healthy: returns all 13, unaffected by the fix', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub([]));
    const result = bridge.callHandler('getClimateFloats', {});

    expect(result.ok).toBe(true);
    expect(result.data.floats.length).toBe(13);
    expect(result.data.skipped).toBe(0);
  });

  it('ONE float throwing: the handler still succeeds and returns the other 12, instead of crashing entirely', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub([4]));
    const result = bridge.callHandler('getClimateFloats', {});

    expect(result.ok).toBe(true);
    expect(result.data.floats.length).toBe(12);
    expect(result.data.skipped).toBe(1);
    expect(result.data.floats.some((f) => f.name === 'FLOAT_TEMPERATURE')).toBe(false);
  });

  it('multiple floats throwing: every OTHER float still comes back', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub([0, 6, 12]));
    const result = bridge.callHandler('getClimateFloats', {});

    expect(result.ok).toBe(true);
    expect(result.data.floats.length).toBe(10);
    expect(result.data.skipped).toBe(3);
  });
});
