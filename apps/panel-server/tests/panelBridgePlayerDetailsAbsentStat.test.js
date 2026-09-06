import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, panelbridge-audit -- TWO fixes to the same bug, landed as two
// commits, both covered here:
//
// (1) getPlayerDetails/getAllPlayerDetails wrapped their entire player table
//     in ONE outer pcall with raw colon-calls: the first throw aborted the
//     whole build, so the caller got NOTHING back -- not even position,
//     username, and access level, all of which work fine. Fixed by routing
//     every field through PanelBridge.tryGet (per-field pcall).
//
// (2) the FIRST pass concluded zombie.characters.Stats has no
//     getHunger/getThirst/getFatigue/etc at all. That was correct about the
//     named getters and WRONG about the capability: Stats works through ONE
//     generic enum-parameterized getter, stats:get(CharacterStat.HUNGER),
//     confirmed against the real jar signature AND against real vanilla
//     SERVER-side Lua that already calls it this exact way
//     (ClientCommands.lua, XpSystem/XpUpdate.lua, Farming/SFarmingSystem.lua
//     -- none of them import/require CharacterStat, it's a bare global in
//     PZ's shared Lua environment). Fixed by statGet() calling
//     stats:get(CharacterStat.X) instead of a named getter -- the feature
//     actually works now, not just fails more gracefully.
//
// FakeStats below models the REAL shape (one generic :get(enumField)
// method), and FakeCharacterStat models the real global enum table -- NOT
// individual named getters, which would silently test the wrong mechanism
// (exactly the trap the pcall-only fix would have fallen into forever).

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
CharacterStat = { HUNGER = "HUNGER", THIRST = "THIRST", FATIGUE = "FATIGUE",
  STRESS = "STRESS", BOREDOM = "BOREDOM", UNHAPPINESS = "UNHAPPINESS",
  PAIN = "PAIN", ENDURANCE = "ENDURANCE" }

FakeStatValues = { HUNGER = 0.4, THIRST = 0.1, FATIGUE = 0.2, STRESS = 5,
  BOREDOM = 0.3, UNHAPPINESS = 0.05, PAIN = 0, ENDURANCE = 0.8 }
FakeStats = {}
function FakeStats:get(enumField) return FakeStatValues[enumField] end

FakeBodyDamage = {}
function FakeBodyDamage:getOverallBodyHealth() return 90 end
function FakeBodyDamage:IsInfected() return false end
function FakeBodyDamage:getIsBleeding() return false end
function FakeBodyDamage:getHealth() return 10 end
function FakeBodyDamage:getTemperature() return 37 end
function FakeBodyDamage:getWetness() return 0 end

FakePlayer = { id = 1 }
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:getDisplayName() return "Fielder" end
function FakePlayer:getX() return 100 end
function FakePlayer:getY() return 200 end
function FakePlayer:getZ() return 0 end
function FakePlayer:getAccessLevel() return "admin" end
function FakePlayer:isAlive() return true end
function FakePlayer:isAsleep() return false end
function FakePlayer:isSneaking() return false end
function FakePlayer:isRunning() return false end
function FakePlayer:getStats() return FakeStats end
function FakePlayer:getBodyDamage() return FakeBodyDamage end

getPlayerByUsername = function(name)
  if name == "Fielder" then return FakePlayer end
  return nil
end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;

describe('PanelBridge.lua getPlayerDetails/getAllPlayerDetails -- real stats via stats:get(CharacterStat.X), pcall narrowed per field', () => {
  it('getPlayerDetails: all eight stats read via the real generic getter, alongside position/username/accessLevel', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('getPlayerDetails', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.username).toBe('Fielder');
    expect(result.data.x).toBe(100);
    expect(result.data.accessLevel).toBe('admin');

    // Before this fix: hunger/thirst/fatigue/boredom/unhappiness/pain were
    // believed absent forever (no named getter exists) and were never
    // populated even with the pcall narrowing alone. They are a real,
    // working feature once read the right way.
    expect(result.data.stats.hunger).toBe(0.4);
    expect(result.data.stats.thirst).toBe(0.1);
    expect(result.data.stats.fatigue).toBe(0.2);
    expect(result.data.stats.stress).toBe(5);
    expect(result.data.stats.boredom).toBe(0.3);
    expect(result.data.stats.unhappiness).toBe(0.05);
    expect(result.data.stats.pain).toBe(0);
    expect(result.data.stats.endurance).toBe(0.8);

    expect(result.data.health.overallBodyHealth).toBe(90);
  });

  it('getAllPlayerDetails: hunger/thirst/fatigue read via the real generic getter, row not degraded to {username, error}', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('getAllPlayerDetails', {});

    expect(result.ok).toBe(true);
    const row = result.data.players[0];
    expect(row.error).toBeUndefined();
    expect(row.username).toBe('Fielder');
    expect(row.hunger).toBe(0.4);
    expect(row.thirst).toBe(0.1);
    expect(row.fatigue).toBe(0.2);
  });

  it('getPlayerDetails: a stat CharacterStat has no member for is honestly OMITTED, not a plausible zero', () => {
    // FakeStatValues has no PANIC entry -- CharacterStat.PANIC itself is a
    // real value in the stub, but the underlying Stats object has nothing
    // for it (models an enum member this handler doesn't ask for, or one
    // whose value is genuinely unset). Not part of the shipped field list,
    // but proves a single missing value doesn't corrupt its siblings.
    const bridge = loadPanelBridge(LUA_PATH, STUBS + `
FakeStatValues.HUNGER = nil
`);
    const result = bridge.callHandler('getPlayerDetails', { username: 'Fielder' });
    expect(result.ok).toBe(true);
    expect(result.data.stats.hunger).toBeUndefined();
    expect('hunger' in result.data.stats).toBe(false);
    expect(result.data.stats.thirst).toBe(0.1);
    expect(result.data.username).toBe('Fielder');
  });

  it('getPlayerDetails: CharacterStat itself missing on some future build degrades stats honestly, without taking down the rest (defensive guard on the enum lookup, not just the method call)', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS + `
CharacterStat = nil
`);
    const result = bridge.callHandler('getPlayerDetails', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.username).toBe('Fielder');
    expect(result.data.x).toBe(100);
    expect(result.data.stats.hunger).toBeUndefined();
    expect(result.data.stats.endurance).toBeUndefined();
    expect(result.data.health.overallBodyHealth).toBe(90);
  });

  it('getPlayerDetails: a player with NO working stats object at all still returns everything else (pre-existing guard, unaffected)', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS + `
function FakePlayer:getStats() return nil end
`);
    const result = bridge.callHandler('getPlayerDetails', { username: 'Fielder' });
    expect(result.ok).toBe(true);
    expect(result.data.username).toBe('Fielder');
    expect(result.data.stats).toEqual({});
  });
});
