import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-31 regression: clearing the PROVISIONAL climate/weather block.
// setSnow/startRain/stopRain are exactly what the operator's live snow and
// rain toggles call.

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

// setSnow reads climate:isRaining() first (to decide whether to also start
// rain), then drives the snow bool via admin override + the direct
// setPrecipitationIsSnow setter, then verifies via getPrecipitationIsSnow().
// setPrecipitationIsSnow is confirmed (javap -c) to write ClimateBool's
// finalValue DIRECTLY, bypassing calculate() -- unlike a plain admin-only
// write, this one IS safe to read back immediately.
function snowStub({ startingIsRaining = true, sticks = true } = {}) {
  return `
FakeSnowBool = { enabledAdmin = false, adminValue = false }
function FakeSnowBool:setEnableAdmin(v) self.enabledAdmin = v end
function FakeSnowBool:setAdminValue(v) self.adminValue = v end
FakeClimate = {
  isSnowNow = false,
  startRainCalls = 0,
  sticks = ${sticks},
}
function FakeClimate:isRaining() return ${startingIsRaining} end
function FakeClimate:transmitServerStartRain(intensity) self.startRainCalls = self.startRainCalls + 1 end
function FakeClimate:getClimateBool(id) return FakeSnowBool end
function FakeClimate:setPrecipitationIsSnow(v)
  if self.sticks then self.isSnowNow = v end
end
function FakeClimate:getPrecipitationIsSnow() return self.isSnowNow end
getClimateManager = function() return FakeClimate end
`;
}

describe('PanelBridge.lua handlers.setSnow -- verify-gates via getPrecipitationIsSnow() (a direct finalValue write, safe to read back immediately)', () => {
  it('enabling snow while already raining: verifies true, does not also start rain', () => {
    const bridge = loadPanelBridge(LUA_PATH, snowStub({ startingIsRaining: true, sticks: true }));
    const result = bridge.callHandler('setSnow', { enabled: true });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(bridge.getGlobal('FakeClimate').startRainCalls).toBe(0);
  });

  it('enabling snow while not raining: starts rain first, then verifies true', () => {
    const bridge = loadPanelBridge(LUA_PATH, snowStub({ startingIsRaining: false, sticks: true }));
    const result = bridge.callHandler('setSnow', { enabled: true, intensity: 0.6 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(bridge.getGlobal('FakeClimate').startRainCalls).toBe(1);
  });

  it('disabling snow: verifies true', () => {
    const bridge = loadPanelBridge(LUA_PATH, snowStub({ startingIsRaining: true, sticks: true }));
    const result = bridge.callHandler('setSnow', { enabled: false });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('THE BUG: the write silently does not stick -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, snowStub({ startingIsRaining: true, sticks: false }));
    const result = bridge.callHandler('setSnow', { enabled: true });

    expect(result.ok).toBe(false);
    expect(result.err).toContain('did not take effect');
  });
});

// startRain/stopRain go through transmitServerStartRain/StopRain, which
// (confirmed via javap -c) call the private updateOnTick() internally
// before returning -- so getPrecipitationIntensity()/isRaining() ARE safe
// to read back immediately here, unlike the plain admin-override floats.
function rainStub({ startSticks = true, stopSticks = true } = {}) {
  return `
FakeClimate = {
  precipitationIntensity = 0,
  startSticks = ${startSticks},
  stopSticks = ${stopSticks},
}
function FakeClimate:transmitServerStartRain(intensity)
  if self.startSticks then
    local clamped = intensity
    if clamped < 0 then clamped = 0 end
    if clamped > 1 then clamped = 1 end
    self.precipitationIntensity = clamped
  end
end
function FakeClimate:transmitServerStopRain()
  if self.stopSticks then self.precipitationIntensity = 0 end
end
function FakeClimate:getPrecipitationIntensity() return self.precipitationIntensity end
function FakeClimate:isRaining() return self.precipitationIntensity > 0 end
getClimateManager = function() return FakeClimate end
`;
}

describe('PanelBridge.lua handlers.startRain -- verify-gates via getPrecipitationIntensity()', () => {
  it('sticks: verifies true, matches the requested intensity', () => {
    const bridge = loadPanelBridge(LUA_PATH, rainStub({ startSticks: true }));
    const result = bridge.callHandler('startRain', { intensity: 0.7 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('THE BUG: the write silently does not stick -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, rainStub({ startSticks: false }));
    const result = bridge.callHandler('startRain', { intensity: 0.7 });

    expect(result.ok).toBe(false);
    expect(result.err).toContain('did not take effect');
  });
});

describe('PanelBridge.lua handlers.stopRain -- verify-gates via isRaining()', () => {
  it('sticks: verifies true', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeClimate = { raining = true, sticks = true }
function FakeClimate:transmitServerStopRain() if self.sticks then self.raining = false end end
function FakeClimate:isRaining() return self.raining end
getClimateManager = function() return FakeClimate end
`);
    const result = bridge.callHandler('stopRain', {});

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('THE BUG: still raining afterward -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeClimate = { raining = true, sticks = false }
function FakeClimate:transmitServerStopRain() if self.sticks then self.raining = false end end
function FakeClimate:isRaining() return self.raining end
getClimateManager = function() return FakeClimate end
`);
    const result = bridge.callHandler('stopRain', {});

    expect(result.ok).toBe(false);
    expect(result.err).toContain('still raining');
  });
});

// resetClimateOverrides: resetAdmin() (confirmed via javap -c) is a genuinely
// unconditional loop -- setEnableAdmin(false) on every float/bool/color,
// no failure path once `climate` itself is valid. Verifies via
// isEnableAdmin() (a trivial, immediate field read, no calculate()
// staleness -- unlike getFinalValue()) across the known floats + snow bool.
function resetStub({ resetAdminAvailable = true, floatsStayOverridden = 0, snowStaysOverridden = false } = {}) {
  const floats = [];
  for (let id = 0; id <= 12; id++) {
    const stillOn = id < floatsStayOverridden;
    floats.push(`  [${id}] = { enabledAdmin = ${stillOn} },`);
  }
  return `
FakeFloats = {
${floats.join('\n')}
}
FakeSnowBool = { enabledAdmin = ${snowStaysOverridden} }
function FakeSnowBool:setEnableAdmin(v) self.enabledAdmin = v end
function FakeSnowBool:isEnableAdmin() return self.enabledAdmin end
FakeClimate = { resetAdminAvailable = ${resetAdminAvailable} }
function FakeClimate:getClimateFloat(id)
  local f = FakeFloats[id]
  if not f then return nil end
  f.setEnableAdmin = function(self2, v) self2.enabledAdmin = v end
  f.isEnableAdmin = function(self2) return self2.enabledAdmin end
  return f
end
function FakeClimate:getClimateBool(id) return FakeSnowBool end
-- Real resetAdmin() is unconditional (confirmed via javap -c) -- this stub
-- deliberately models a hypothetical broken one (leaving the first
-- floatsStayOverridden floats/the snow bool untouched) purely to prove the
-- NEW isEnableAdmin() read-back would catch it if it ever happened, same
-- "sticks" convention this file's other break-verify-style tests use.
function FakeClimate:resetAdmin()
  if not self.resetAdminAvailable then error("resetAdmin not available") end
  for id = ${floatsStayOverridden}, 12 do
    local f = FakeFloats[id]
    if f then f.enabledAdmin = false end
  end
  if not ${snowStaysOverridden} then FakeSnowBool.enabledAdmin = false end
end
getClimateManager = function() return FakeClimate end
`;
}

describe('PanelBridge.lua handlers.resetClimateOverrides -- verify-gates via isEnableAdmin() read-back, not a bare invoke()-didn\'t-throw claim', () => {
  it('resetAdmin() path, genuinely clean: verifies true', () => {
    const bridge = loadPanelBridge(LUA_PATH, resetStub({ resetAdminAvailable: true, floatsStayOverridden: 0, snowStaysOverridden: false }));
    const result = bridge.callHandler('resetClimateOverrides', {});

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('THE BUG shape: resetAdmin() call succeeds but some overrides are still active -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, resetStub({ resetAdminAvailable: true, floatsStayOverridden: 3, snowStaysOverridden: true }));
    const result = bridge.callHandler('resetClimateOverrides', {});

    expect(result.ok).toBe(false);
    expect(result.err).toContain('still active');
  });
});
