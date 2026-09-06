import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, regression, item 1 -- the highest-ranked of the four
// remaining items (identical shape to getClimateFloats, which needed a real
// fix earlier tonight for a real observed crash). handlers.getWeather wrapped
// all 15 field reads (12 of them bare direct calls with no PanelBridge.safeGet)
// in ONE pcall, so a single throwing getter crashed the whole handler and lost
// the other 14 fields, which would have read fine on their own. Same per-item
// isolation pattern as getClimateFloats (8519ea4e): one broken field is
// skipped (and counted in a new `skipped` field) instead of taking down the
// rest.

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

function climateStub(brokenKeys) {
  const broken = new Set(brokenKeys);
  function m(key, value) {
    if (broken.has(key)) return `error("simulated engine failure: ${key}")`;
    return `return ${value}`;
  }
  return `
FakeClimate = {}
function FakeClimate:getTemperature() ${m('temperature', '20.0')} end
function FakeClimate:getHumidity() ${m('humidity', '0.5')} end
function FakeClimate:getWindspeedKph() ${m('windSpeed', '10.0')} end
function FakeClimate:getWindAngleDegrees() ${m('windAngle', '90.0')} end
function FakeClimate:getFogIntensity() ${m('fogIntensity', '0.1')} end
function FakeClimate:getCloudIntensity() ${m('cloudIntensity', '0.3')} end
function FakeClimate:getPrecipitationIntensity() ${m('precipitationIntensity', '0.0')} end
function FakeClimate:isRaining() ${m('isRaining', 'false')} end
function FakeClimate:isSnowing() ${m('isSnowing', 'false')} end
function FakeClimate:getIsThunderStorming() ${m('isThunderStorming', 'false')} end
function FakeClimate:getDayLightStrength() ${m('dayLight', '1.0')} end
function FakeClimate:getNightStrength() ${m('nightStrength', '0.0')} end
function FakeClimate:getDesaturation() ${m('desaturation', '0.0')} end
function FakeClimate:getViewDistance() ${m('viewDistance', '1.0')} end
function FakeClimate:getAmbient() ${m('ambient', '1.0')} end
getClimateManager = function() return FakeClimate end
`;
}

describe('PanelBridge.lua handlers.getWeather -- one throwing field no longer crashes the whole handler', () => {
  it('all 15 fields healthy: returns all of them, skipped is 0', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub([]));
    const result = bridge.callHandler('getWeather', {});

    expect(result.ok).toBe(true);
    expect(result.data.skipped).toBe(0);
    expect(result.data.temperature).toBe(20.0);
    expect(result.data.isRaining).toBe(false);
    expect(result.data.ambient).toBe(1.0);
  });

  it('ONE field throwing: the handler still succeeds and returns the other 14, instead of crashing entirely', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub(['windSpeed']));
    const result = bridge.callHandler('getWeather', {});

    expect(result.ok).toBe(true);
    expect(result.data.skipped).toBe(1);
    expect(result.data.windSpeed).toBeUndefined();
    // Every other field still comes back, unaffected.
    expect(result.data.temperature).toBe(20.0);
    expect(result.data.humidity).toBe(0.5);
    expect(result.data.isRaining).toBe(false);
  });

  it('multiple fields throwing: every OTHER field still comes back', () => {
    // ambient/viewDistance/isThunderStorming go through PanelBridge.safeGet,
    // which already swallows a throw and returns its own default -- so they
    // deliberately can't "skip" here. Pick three of the twelve bare-call
    // fields that DO propagate the throw to this handler's own per-field pcall.
    const bridge = loadPanelBridge(LUA_PATH, climateStub(['temperature', 'dayLight', 'windAngle']));
    const result = bridge.callHandler('getWeather', {});

    expect(result.ok).toBe(true);
    expect(result.data.skipped).toBe(3);
    expect(result.data.temperature).toBeUndefined();
    expect(result.data.dayLight).toBeUndefined();
    expect(result.data.windAngle).toBeUndefined();
    expect(result.data.humidity).toBe(0.5);
    expect(result.data.ambient).toBe(1.0);
  });
});
