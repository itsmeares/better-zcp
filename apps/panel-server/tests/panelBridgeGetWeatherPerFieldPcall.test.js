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
    expect(result.data.temperature).toBe(20.0);
    expect(result.data.humidity).toBe(0.5);
    expect(result.data.isRaining).toBe(false);
  });

  it('multiple fields throwing: every OTHER field still comes back', () => {
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
