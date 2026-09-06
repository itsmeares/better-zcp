import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-31 regression follow-up (operator: "fix them" -- this is the finding
// from the stopWeather pass, reported then, fixed now). triggerCustomWeatherStage
// and triggerCustomWeather both return a real boolean on the real B42 jar --
// confirmed via javap -c: both early-return false when weatherPeriod:isRunning()
// is already true. But `if PanelBridge.invoke(...) then` only checks invoke()'s
// FIRST return (whether the pcall threw), discarding the SECOND (the callee's
// own result) -- so triggering a second storm/blizzard/tropical-storm/weather-
// period while one is already running reported success and did nothing. This
// models that mechanism, NOT the real Java class -- see panelBridgeLua.js's
// own honest-limit header.
//
// generateWeather had a WORSE version of the same shape: transmitGenerateWeather
// (a void, ClientOnly-packet method -- confirmed via the same bytecode read,
// same class as transmitStopWeather) was tried FIRST and never throws, so
// triggerCustomWeather -- the real, boolean-returning, verifiable method --
// was NEVER reached, for any frontType, ever. Fixed by trying
// triggerCustomWeather first whenever the front type can represent it
// (frontType ~= 0 -- stationary has no boolean equivalent).

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

function climateStub({ periodAlreadyRunning = false } = {}) {
  return `
WeatherPeriod = {
  STAGE_BLIZZARD = 7,
  STAGE_TROPICAL_STORM = 8,
  STAGE_STORM = 3,
}
FakeClimate = {
  periodAlreadyRunning = ${periodAlreadyRunning},
  transmitTriggerBlizzardCalls = 0,
  transmitTriggerTropicalCalls = 0,
  transmitTriggerStormCalls = 0,
  transmitGenerateWeatherCalls = 0,
}
-- Real bytecode shape: both early-return false (a no-op, no exception) when
-- a weather period is already running -- the only reason they'd return false
-- server-side (GameClient.client is always false in this context).
function FakeClimate:triggerCustomWeatherStage(stage, duration)
  if self.periodAlreadyRunning then return false end
  self.periodAlreadyRunning = true
  self.lastStage = stage
  return true
end
function FakeClimate:triggerCustomWeather(strength, warm)
  if self.periodAlreadyRunning then return false end
  self.periodAlreadyRunning = true
  self.lastWarm = warm
  return true
end
-- Legacy/B41 fallback, void, ClientOnly packet on the real jar -- no boolean
-- to report, just record that it was (or wasn't) reached.
function FakeClimate:transmitTriggerBlizzard(duration) self.transmitTriggerBlizzardCalls = self.transmitTriggerBlizzardCalls + 1 end
function FakeClimate:transmitTriggerTropical(duration) self.transmitTriggerTropicalCalls = self.transmitTriggerTropicalCalls + 1 end
function FakeClimate:transmitTriggerStorm(duration) self.transmitTriggerStormCalls = self.transmitTriggerStormCalls + 1 end
function FakeClimate:transmitGenerateWeather(strength, javaFrontType) self.transmitGenerateWeatherCalls = self.transmitGenerateWeatherCalls + 1 end
getClimateManager = function() return FakeClimate end
`;
}

describe('PanelBridge.lua handlers.triggerBlizzard -- verify-gates on the real boolean instead of trusting invoke() not throwing', () => {
  it('no period running: triggers and verifies true, never touches the legacy fallback', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: false }));
    const result = bridge.callHandler('triggerBlizzard', { duration: 3 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(bridge.getGlobal('FakeClimate').transmitTriggerBlizzardCalls).toBe(0);
  });

  it('THE BUG: a period is already running -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: true }));
    const result = bridge.callHandler('triggerBlizzard', { duration: 3 });

    expect(result.ok).toBe(false);
    expect(result.err).toContain('already running');
  });
});

describe('PanelBridge.lua handlers.triggerTropicalStorm -- same fix', () => {
  it('no period running: triggers and verifies true', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: false }));
    const result = bridge.callHandler('triggerTropicalStorm', { duration: 3 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('a period is already running -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: true }));
    const result = bridge.callHandler('triggerTropicalStorm', { duration: 3 });

    expect(result.ok).toBe(false);
    expect(result.err).toContain('already running');
  });
});

describe('PanelBridge.lua handlers.triggerStorm -- same fix', () => {
  it('no period running: triggers and verifies true', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: false }));
    const result = bridge.callHandler('triggerStorm', { duration: 3 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('a period is already running -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: true }));
    const result = bridge.callHandler('triggerStorm', { duration: 3 });

    expect(result.ok).toBe(false);
    expect(result.err).toContain('already running');
  });
});

describe('PanelBridge.lua handlers.generateWeather -- tries the real boolean-returning method first, falls back only for stationary', () => {
  it('warm front (frontType 2): uses triggerCustomWeather, never reaches the ClientOnly fallback', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: false }));
    const result = bridge.callHandler('generateWeather', { strength: 0.7, frontType: 2 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(bridge.getGlobal('FakeClimate').transmitGenerateWeatherCalls).toBe(0);
    expect(bridge.getGlobal('FakeClimate').lastWarm).toBe(true);
  });

  it('cold front (frontType 1): uses triggerCustomWeather with warm=false', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: false }));
    const result = bridge.callHandler('generateWeather', { strength: 0.7, frontType: 1 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(bridge.getGlobal('FakeClimate').lastWarm).toBe(false);
  });

  it('THE BUG: a period is already running (warm/cold front) -- must NOT report success', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: true }));
    const result = bridge.callHandler('generateWeather', { strength: 0.7, frontType: 2 });

    expect(result.ok).toBe(false);
    expect(result.err).toContain('already running');
  });

  it('stationary front (frontType 0): triggerCustomWeather cannot represent it, falls back to the unverifiable legacy method', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ periodAlreadyRunning: false }));
    const result = bridge.callHandler('generateWeather', { strength: 0.7, frontType: 0 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('unverifiable');
    expect(bridge.getGlobal('FakeClimate').transmitGenerateWeatherCalls).toBe(1);
  });
});
