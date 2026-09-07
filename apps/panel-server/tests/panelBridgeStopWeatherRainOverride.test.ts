import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.ts';


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

function climateStub({ raining = true, adminOverride = false, stopRainSticks = true } = {}) {
  return `
FakeClimate = {
  raining = ${raining},
  adminOverride = ${adminOverride},
  stopRainSticks = ${stopRainSticks},
}
function FakeClimate:stopWeatherAndThunder()
  -- Real bytecode shape: stops the weather PERIOD, never touches a
  -- ClimateFloat's own admin-override state.
  if not self.adminOverride then
    self.raining = false
  end
end
function FakeClimate:transmitServerStopRain()
  if self.stopRainSticks then
    self.adminOverride = false
    self.raining = false
  end
end
function FakeClimate:isRaining() return self.raining end
getClimateManager = function() return FakeClimate end
`;
}

describe('PanelBridge.lua handlers.stopWeather -- clears a lingering rain admin-override, verifies by effect', () => {
  it('natural rain (no admin override, the case that already worked): stops and verifies true', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ raining: true, adminOverride: false }));
    const result = bridge.callHandler('stopWeather', {});

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('THE BUG: rain admin-forced by startRain/setSnow -- stopWeatherAndThunder alone leaves it raining, the fix clears it too', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ raining: true, adminOverride: true, stopRainSticks: true }));
    const result = bridge.callHandler('stopWeather', {});

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('must NOT report success when the rain override silently does not clear', () => {
    const bridge = loadPanelBridge(LUA_PATH, climateStub({ raining: true, adminOverride: true, stopRainSticks: false }));
    const result = bridge.callHandler('stopWeather', {});

    expect(result.ok).toBe(false);
    expect(result.err).toContain('still raining');
  });

  it('ClimateManager unavailable reports a real error, not a false success', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'getClimateManager = function() return nil end');
    const result = bridge.callHandler('stopWeather', {});

    expect(result.ok).toBe(false);
    expect(result.err).toContain('ClimateManager not available');
  });
});
