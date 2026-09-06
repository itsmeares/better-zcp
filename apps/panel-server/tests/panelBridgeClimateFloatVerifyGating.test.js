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

function floatStub({ floatAvailable = true, sticks = true, min = 0, max = 1 } = {}) {
  return `
FakeFloat = {
  min = ${min}, max = ${max},
  adminValue = 0,
  enabledAdmin = false,
  sticks = ${sticks},
}
function FakeFloat:setEnableAdmin(v) self.enabledAdmin = v end
function FakeFloat:isEnableAdmin() return self.enabledAdmin end
function FakeFloat:setAdminValue(v)
  if not self.sticks then return end
  if v < self.min then v = self.min end
  if v > self.max then v = self.max end
  self.adminValue = v
end
function FakeFloat:getAdminValue() return self.adminValue end
-- Deliberately NOT kept in sync with adminValue -- getFinalValue() is stale
-- immediately after a plain admin-override write on the real jar too; a
-- handler that reads this instead of getAdminValue() would see 0 forever
-- and always report verified=false, which is exactly the regression this
-- suite exists to catch.
function FakeFloat:getFinalValue() return 0 end
FakeClimate = {
  floatAvailable = ${floatAvailable},
  directSetterCalls = 0,
}
function FakeClimate:getClimateFloat(id)
  if self.floatAvailable then return FakeFloat end
  return nil
end
function FakeClimate:setDayLightStrength(v) self.directSetterCalls = self.directSetterCalls + 1 end
function FakeClimate:setNightStrength(v) self.directSetterCalls = self.directSetterCalls + 1 end
function FakeClimate:setDesaturation(v) self.directSetterCalls = self.directSetterCalls + 1 end
function FakeClimate:setViewDistance(v) self.directSetterCalls = self.directSetterCalls + 1 end
function FakeClimate:setAmbient(v) self.directSetterCalls = self.directSetterCalls + 1 end
getClimateManager = function() return FakeClimate end
`;
}

const DIRECT_SETTER_HANDLERS = [
  { handler: 'setDayLight', value: 0.7 },
  { handler: 'setNightStrength', value: 0.4 },
  { handler: 'setDesaturation', value: 0.3 },
  { handler: 'setViewDistance', value: 0.6 },
  { handler: 'setAmbient', value: 0.9 },
];

describe.each(DIRECT_SETTER_HANDLERS)('PanelBridge.lua handlers.$handler -- verify-gates via getAdminValue(), not getFinalValue()', ({ handler, value }) => {
  it('admin override sticks: verifies true', () => {
    const bridge = loadPanelBridge(LUA_PATH, floatStub({ sticks: true, min: 0, max: 1 }));
    const result = bridge.callHandler(handler, { value });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(bridge.getGlobal('FakeClimate').directSetterCalls).toBe(0);
  });

  it('THE BUG: admin write silently does not stick -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, floatStub({ sticks: false, min: 0, max: 1 }));
    const result = bridge.callHandler(handler, { value });

    expect(result.ok).toBe(false);
    expect(result.err).toContain('did not stick');
  });

  it('no ClimateFloat available: falls back to the direct setter, unverifiable', () => {
    const bridge = loadPanelBridge(LUA_PATH, floatStub({ floatAvailable: false }));
    const result = bridge.callHandler(handler, { value });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('unverifiable');
    expect(bridge.getGlobal('FakeClimate').directSetterCalls).toBe(1);
  });
});

describe('PanelBridge.lua handlers.setDayLight -- clamping catch (real failure class pcall-not-throwing cannot see)', () => {
  it('a value outside the float\'s real min/max silently clamps -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, floatStub({ sticks: true, min: 0, max: 1 }));
    const result = bridge.callHandler('setDayLight', { value: 5.0 });

    expect(result.ok).toBe(false);
    expect(result.err).toContain('did not stick');
  });
});

function adminOnlyFloatStub({ floatAvailable = true, sticks = true, min = -50, max = 50 } = {}) {
  return `
FakeFloat = {
  min = ${min}, max = ${max},
  adminValue = 0,
  enabledAdmin = false,
  sticks = ${sticks},
}
function FakeFloat:setEnableAdmin(v) self.enabledAdmin = v end
function FakeFloat:isEnableAdmin() return self.enabledAdmin end
function FakeFloat:setAdminValue(v)
  if not self.sticks then return end
  if v < self.min then v = self.min end
  if v > self.max then v = self.max end
  self.adminValue = v
end
function FakeFloat:getAdminValue() return self.adminValue end
function FakeFloat:getName() return "Test Float" end
FakeClimate = { floatAvailable = ${floatAvailable} }
function FakeClimate:getClimateFloat(id)
  if self.floatAvailable then return FakeFloat end
  return nil
end
getClimateManager = function() return FakeClimate end
`;
}

const ADMIN_ONLY_HANDLERS = [
  { handler: 'setTemperature', value: 25, min: -50, max: 50 },
  { handler: 'setWind', value: 0.5, min: 0, max: 1 },
  { handler: 'setFog', value: 0.3, min: 0, max: 1 },
  { handler: 'setClouds', value: 0.6, min: 0, max: 1 },
];

describe.each(ADMIN_ONLY_HANDLERS)('PanelBridge.lua handlers.$handler -- admin-only float (no direct-setter fallback in the real API), verify-gates via getAdminValue()', ({ handler, value, min, max }) => {
  it('admin override sticks: verifies true', () => {
    const bridge = loadPanelBridge(LUA_PATH, adminOnlyFloatStub({ sticks: true, min, max }));
    const result = bridge.callHandler(handler, { value });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('THE BUG: admin write silently does not stick -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, adminOnlyFloatStub({ sticks: false, min, max }));
    const result = bridge.callHandler(handler, { value });

    expect(result.ok).toBe(false);
    expect(result.err).toContain('did not stick');
  });

  it('no ClimateFloat available: hard failure, no fallback exists for this float', () => {
    const bridge = loadPanelBridge(LUA_PATH, adminOnlyFloatStub({ floatAvailable: false, min, max }));
    const result = bridge.callHandler(handler, { value });

    expect(result.ok).toBe(false);
  });
});

describe('PanelBridge.lua handlers.setClimateFloat -- generic setter, both enable and disable branches', () => {
  it('enabling: verifies via getAdminValue()', () => {
    const bridge = loadPanelBridge(LUA_PATH, adminOnlyFloatStub({ sticks: true, min: 0, max: 1 }));
    const result = bridge.callHandler('setClimateFloat', { floatId: 3, value: 0.8, enable: true });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('enabling but the write silently does not stick -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, adminOnlyFloatStub({ sticks: false, min: 0, max: 1 }));
    const result = bridge.callHandler('setClimateFloat', { floatId: 3, value: 0.8, enable: true });

    expect(result.ok).toBe(false);
  });

  it('disabling: verifies via isEnableAdmin() flipping false', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeFloat = { enabledAdmin = true }
function FakeFloat:setEnableAdmin(v) self.enabledAdmin = v end
function FakeFloat:isEnableAdmin() return self.enabledAdmin end
function FakeFloat:setAdminValue(v) end
function FakeFloat:getAdminValue() return 0 end
function FakeFloat:getName() return "Test" end
FakeClimate = {}
function FakeClimate:getClimateFloat(id) return FakeFloat end
getClimateManager = function() return FakeClimate end
`);
    const result = bridge.callHandler('setClimateFloat', { floatId: 3, value: 0, enable: false });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });
});
