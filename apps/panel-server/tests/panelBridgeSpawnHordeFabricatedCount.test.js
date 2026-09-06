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

const COMMON_STUBS = `
ZombRand = function(n) return 0 end

-- getDir() returns the real IsoDirections Java enum, not a string --
-- confirmed against real vanilla Lua (see
-- panelBridgeSpawnHordeBehindDirection.test.js for the full citation). A
-- bare-string stub here would silently validate spawnHordeBehindPlayer's
-- string-keyed direction lookup bug instead of catching it.
local function mkDir(name)
    local d = {}
    function d:toString() return name end
    return d
end
IsoDirections = {
    N = mkDir("N"), NE = mkDir("NE"), E = mkDir("E"), SE = mkDir("SE"),
    S = mkDir("S"), SW = mkDir("SW"), W = mkDir("W"), NW = mkDir("NW"),
}

FakePlayer = { x = 100, y = 100, z = 0, dir = IsoDirections.N, username = "Test" }
function FakePlayer:getX() return self.x end
function FakePlayer:getY() return self.y end
function FakePlayer:getZ() return self.z end
function FakePlayer:getDir() return self.dir end
function FakePlayer:getUsername() return self.username end

FakePlayerList = { FakePlayer }
function FakePlayerList:size() return 1 end
function FakePlayerList:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakePlayerList end
`;

const FALLBACK_ONLY_STUBS = COMMON_STUBS + `
FakeZPM = {}
function FakeZPM:createHordeInAreaTo(...) end
ZombiePopulationManager = { instance = FakeZPM }
`;

const VZM_STUBS = COMMON_STUBS + `
FakeVZM = {}
function FakeVZM:createRealZombieNow(x, y, z) return { x = x, y = y, z = z } end
VirtualZombieManager = { instance = FakeVZM }
`;

const NOOP_VZM_STUBS = COMMON_STUBS + `
FakeVZM = {}
function FakeVZM:createRealZombieNow(x, y, z) return nil end
VirtualZombieManager = { instance = FakeVZM }
`;

describe('PanelBridge.lua handlers.spawnHordeNearPlayer/BehindPlayer -- fallback branches must not fabricate a spawned count', () => {
  it('spawnHordeNearPlayer reports a real per-zombie count when VirtualZombieManager returns zombies (verified="confirmed")', () => {
    const bridge = loadPanelBridge(LUA_PATH, VZM_STUBS);
    const result = bridge.callHandler('spawnHordeNearPlayer', { username: 'Test', count: 5 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(result.data.spawned).toBe(5);
    expect(result.data.method).toBe('VirtualZombieManager.createRealZombieNow');
  });

  it('does not report success when the coordinate spawn method creates no zombies', () => {
    const bridge = loadPanelBridge(LUA_PATH, NOOP_VZM_STUBS);
    const result = bridge.callHandler('spawnHordeNearPlayer', { username: 'Test', count: 5 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/no zombies were created/);
  });

  it('spawnHordeNearPlayer must NOT claim a spawned count from the createHordeInAreaTo fallback (verified="unverifiable", spawned unset)', () => {
    const bridge = loadPanelBridge(LUA_PATH, FALLBACK_ONLY_STUBS);
    const result = bridge.callHandler('spawnHordeNearPlayer', { username: 'Test', count: 50 });

    expect(result.ok).toBe(true);
    expect(result.data.method).toBe('createHordeInAreaTo');
    expect(result.data.verified).toBe('unverifiable');
    expect(result.data.spawned == null).toBe(true);
  });

  it('spawnHordeBehindPlayer must NOT claim a spawned count from the createHordeInAreaTo fallback (verified="unverifiable", spawned unset)', () => {
    const bridge = loadPanelBridge(LUA_PATH, FALLBACK_ONLY_STUBS);
    const result = bridge.callHandler('spawnHordeBehindPlayer', { username: 'Test', count: 50 });

    expect(result.ok).toBe(true);
    expect(result.data.method).toBe('createHordeInAreaTo');
    expect(result.data.verified).toBe('unverifiable');
    expect(result.data.spawned == null).toBe(true);
  });

  it('spawnHordeBehindPlayer does not report success when the coordinate spawn method creates no zombies', () => {
    const bridge = loadPanelBridge(LUA_PATH, NOOP_VZM_STUBS);
    const result = bridge.callHandler('spawnHordeBehindPlayer', { username: 'Test', count: 5 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/no zombies were created/);
  });
});
