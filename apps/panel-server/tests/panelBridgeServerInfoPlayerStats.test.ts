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

const STUBS = `
CharacterStat = { HUNGER = "HUNGER", THIRST = "THIRST", FATIGUE = "FATIGUE" }

FakeStatValues = { HUNGER = 0.62, THIRST = 0.18, FATIGUE = 0.4 }
FakeStats = {}
function FakeStats:get(enumField) return FakeStatValues[enumField] end

FakeBodyDamage = {}
function FakeBodyDamage:getOverallBodyHealth() return 85 end
function FakeBodyDamage:IsInfected() return false end

FakePlayer = {}
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:getX() return 100 end
function FakePlayer:getY() return 200 end
function FakePlayer:getZ() return 0 end
function FakePlayer:getAccessLevel() return "admin" end
function FakePlayer:isAlive() return true end
function FakePlayer:getBodyDamage() return FakeBodyDamage end
function FakePlayer:getStats() return FakeStats end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end

FakeGameTime = {}
function FakeGameTime:getTimeOfDay() return 12.5 end
function FakeGameTime:getDay() return 15 end
function FakeGameTime:getMonth() return 5 end
function FakeGameTime:getYear() return 1993 end
getGameTime = function() return FakeGameTime end
`;

describe('PanelBridge.lua getServerInfo -- players carry real hunger/thirst/fatigue for the WorldMap dossier', () => {
  it('reports the real per-player stats, not silently-absent fields', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('getServerInfo', {});

    expect(result.ok).toBe(true);
    const row = result.data.players[0];
    expect(row.name).toBe('Fielder');
    expect(row.health).toBe(85);
    expect(row.hunger).toBe(0.62);
    expect(row.thirst).toBe(0.18);
    expect(row.fatigue).toBe(0.4);
  });

  it('a player with no working stats object still returns the rest of the row (hunger/thirst/fatigue honestly omitted)', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS + `
function FakePlayer:getStats() return nil end
`);
    const result = bridge.callHandler('getServerInfo', {});

    expect(result.ok).toBe(true);
    const row = result.data.players[0];
    expect(row.name).toBe('Fielder');
    expect(row.health).toBe(85);
    expect(row.hunger).toBeUndefined();
    expect(row.thirst).toBeUndefined();
    expect(row.fatigue).toBeUndefined();
  });
});
