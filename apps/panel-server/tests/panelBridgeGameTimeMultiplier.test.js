import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, panelbridge-audit: the panel's time-speed slider
// (apps/panel-client/src/pages/Events.tsx) is useState(1) and never reads back, so it
// shows a stale multiplier after any change made via RCON or another admin.
// handlers.getGameTime already holds the GameTime singleton (`gameTime`) for
// its other fields -- this adds gameTime:getMultiplier() to that same
// object, zero new round-trips. Pam jar-confirmed RCON's setTimeSpeed writes
// this exact same singleton/field (GameTime.getInstance():setMultiplier()),
// so this read-back is authoritative, not decorative.

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

const STUBS = `
FakeGameTime = { multiplier = 1 }
function FakeGameTime:getTimeOfDay() return 12.5 end
function FakeGameTime:getYear() return 1993 end
function FakeGameTime:getMonth() return 6 end
function FakeGameTime:getDay() return 15 end
function FakeGameTime:getWorldAgeHours() return 100 end
function FakeGameTime:getNightsSurvived() return 4 end
function FakeGameTime:getMultiplier() return self.multiplier end
getGameTime = function() return FakeGameTime end
`;

describe('PanelBridge.lua getGameTime -- real multiplier read-back for the time-speed slider', () => {
  it('reports the real current multiplier, not a hardcoded 1', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('FakeGameTime.multiplier = 3');

    const result = bridge.callHandler('getGameTime', {});
    expect(result.ok).toBe(true);
    expect(result.data.multiplier).toBe(3);
    // Every other field this handler already returns must still be intact.
    expect(result.data.year).toBe(1993);
    expect(result.data.nightsSurvived).toBe(4);
  });

  it('falls back to 1 (not a crash) if getMultiplier is unavailable on this build', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeGameTime = {}
function FakeGameTime:getTimeOfDay() return 12.5 end
function FakeGameTime:getYear() return 1993 end
function FakeGameTime:getMonth() return 6 end
function FakeGameTime:getDay() return 15 end
function FakeGameTime:getWorldAgeHours() return 100 end
function FakeGameTime:getNightsSurvived() return 4 end
getGameTime = function() return FakeGameTime end
`);
    const result = bridge.callHandler('getGameTime', {});
    expect(result.ok).toBe(true);
    expect(result.data.multiplier).toBe(1);
  });
});
