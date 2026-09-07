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

const ISO_DIRECTIONS_STUB = `
local function mkDir(name)
    local d = {}
    function d:toString() return name end
    return d
end
IsoDirections = {
    N = mkDir("N"), NE = mkDir("NE"), E = mkDir("E"), SE = mkDir("SE"),
    S = mkDir("S"), SW = mkDir("SW"), W = mkDir("W"), NW = mkDir("NW"),
}
`;

function stubsForDir(dirExpr) {
  return ISO_DIRECTIONS_STUB + `
ZombRand = function(n) return 0 end

FakePlayer = { x = 100, y = 100, z = 0, username = "Test" }
function FakePlayer:getX() return self.x end
function FakePlayer:getY() return self.y end
function FakePlayer:getZ() return self.z end
function FakePlayer:getDir() return ${dirExpr} end
function FakePlayer:getUsername() return self.username end

-- handlers.spawnHordeBehindPlayer resolves the username via PanelBridge.lua's
-- own LOCAL getPlayerByUsername helper, which iterates getOnlinePlayers() --
-- a global getPlayerByUsername stub would be lexically shadowed and never
-- called, so it's getOnlinePlayers() that must be stubbed.
FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end

FakeVZM = {}
function FakeVZM:createRealZombieNow(x, y, z) return { x = x, y = y, z = z } end
VirtualZombieManager = { instance = FakeVZM }
`;
}

describe('PanelBridge.lua handlers.spawnHordeBehindPlayer -- real facing direction, not a permanent silent default', () => {
  it('player facing SOUTH: horde spawns to the NORTH (cy decreases), not the old hardcoded south-of-player default', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsForDir('IsoDirections.S'));
    const result = bridge.callHandler('spawnHordeBehindPlayer', { username: 'Test', count: 3 });

    expect(result.ok).toBe(true);
    expect(result.data.playerDirection).toBe('S');
    expect(result.data.center).toEqual({ x: 100, y: 85 });
  });

  it('player facing WEST: horde spawns to the EAST (cx increases)', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsForDir('IsoDirections.W'));
    const result = bridge.callHandler('spawnHordeBehindPlayer', { username: 'Test', count: 3 });

    expect(result.ok).toBe(true);
    expect(result.data.playerDirection).toBe('W');
    expect(result.data.center).toEqual({ x: 115, y: 100 });
  });

  it('player facing NORTH: horde spawns to the SOUTH (the one direction the old bug always produced, now for the right reason)', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsForDir('IsoDirections.N'));
    const result = bridge.callHandler('spawnHordeBehindPlayer', { username: 'Test', count: 3 });

    expect(result.ok).toBe(true);
    expect(result.data.playerDirection).toBe('N');
    expect(result.data.center).toEqual({ x: 100, y: 115 });
  });

  it('getDir() unavailable: falls back to due-south (facing-north default), reports direction as "unknown" rather than a fabricated one', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsForDir('nil'));
    const result = bridge.callHandler('spawnHordeBehindPlayer', { username: 'Test', count: 3 });

    expect(result.ok).toBe(true);
    expect(result.data.playerDirection).toBe('unknown');
    expect(result.data.center).toEqual({ x: 100, y: 115 });
  });
});
