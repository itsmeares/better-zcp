import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, regression, item 2 -- three of getPlayerDetails'
// health fields were always nil on the real B42 jar (the audit):
//
// isBleeding -- getIsBleeding() does not exist; no boolean bleeding getter
//   exists at all. The real method is getNumPartsBleeding() -> int. `> 0`
//   is a SEMANTIC REINTERPRETATION (count -> boolean), not a rename.
// temperature -- getTemperature() does not exist directly on BodyDamage; it
//   is two hops, bodyDamage:getThermoregulator():getCoreTemperature().
// wetness -- REMOVED entirely. No whole-body wetness concept exists
//   anywhere on BodyDamage under any name at any hop -- only mutators, zero
//   getters. Not substituted with a near-miss from a different object.

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

function stubs({ numPartsBleeding = 0, coreTemperature = 37, hasThermoregulator = true } = {}) {
  return `
CharacterStat = { HUNGER = "HUNGER" }
FakeStats = {}
function FakeStats:get(enumField) return nil end

FakeThermoregulator = {}
function FakeThermoregulator:getCoreTemperature() return ${coreTemperature} end

FakeBodyDamage = {}
function FakeBodyDamage:getOverallBodyHealth() return 90 end
function FakeBodyDamage:IsInfected() return false end
function FakeBodyDamage:getHealth() return 10 end
function FakeBodyDamage:getNumPartsBleeding() return ${numPartsBleeding} end
${hasThermoregulator ? 'function FakeBodyDamage:getThermoregulator() return FakeThermoregulator end' : ''}

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
}

describe('PanelBridge.lua handlers.getPlayerDetails -- isBleeding/temperature use the real jar API, wetness is removed', () => {
  it('isBleeding is derived from getNumPartsBleeding() > 0, not a nonexistent getIsBleeding()', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ numPartsBleeding: 2 }));
    const result = bridge.callHandler('getPlayerDetails', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.health.isBleeding).toBe(true);
  });

  it('zero parts bleeding reports isBleeding=false, not nil', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ numPartsBleeding: 0 }));
    const result = bridge.callHandler('getPlayerDetails', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.health.isBleeding).toBe(false);
  });

  it('temperature is read via the real two-hop getThermoregulator():getCoreTemperature()', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ coreTemperature: 38.5 }));
    const result = bridge.callHandler('getPlayerDetails', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.health.temperature).toBe(38.5);
  });

  it('missing thermoregulator (first hop unavailable) omits temperature honestly instead of crashing the second hop', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ hasThermoregulator: false }));
    const result = bridge.callHandler('getPlayerDetails', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.health.temperature).toBeUndefined();
    expect(result.data.health.overallBodyHealth).toBe(90);
  });

  it('wetness field is gone entirely -- not present, not nil, not a near-miss substitute', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs());
    const result = bridge.callHandler('getPlayerDetails', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect('wetness' in result.data.health).toBe(false);
  });
});
