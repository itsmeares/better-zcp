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

function playerStub(sticks) {
  return `
FakePlayer = { x = 100, y = 100, z = 0, sticks = ${sticks} }
function FakePlayer:getUsername() return "Test" end
function FakePlayer:getX() return self.x end
function FakePlayer:getY() return self.y end
function FakePlayer:getZ() return self.z end
function FakePlayer:teleportTo(nx, ny, nz)
  if self.sticks then self.x, self.y, self.z = nx, ny, nz end
end
function FakePlayer:setX(v) if self.sticks then self.x = v end end
function FakePlayer:setY(v) if self.sticks then self.y = v end end
function FakePlayer:setZ(v) if self.sticks then self.z = v end end
function FakePlayer:setLx(v) end
function FakePlayer:setLy(v) end
function FakePlayer:setLz(v) end

FakePlayerList = { FakePlayer }
function FakePlayerList:size() return 1 end
function FakePlayerList:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakePlayerList end
`;
}

describe('PanelBridge.lua handlers.teleportPlayer -- gate ok on distance actually moved, not proximity to target', () => {
  it('reports success and verified=true for a long teleport that actually sticks', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub(true));
    const result = bridge.callHandler('teleportPlayer', { username: 'Test', x: 5000, y: 6000, z: 0 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(result.data.verifyPosition).toEqual({ x: 5000, y: 6000, z: 0 });
  });

  it('must NOT report success for a long teleport that silently does not stick (player still at origin)', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub(false));
    const result = bridge.callHandler('teleportPlayer', { username: 'Test', x: 5000, y: 6000, z: 0 });

    expect(result.ok).toBe(false);
    expect(result.data.verifyPosition).toEqual({ x: 100, y: 100, z: 0 });
  });

  it('reports unverified (not a false pass or fail) for a short teleport where origin and target are indistinguishable', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub(false));
    const result = bridge.callHandler('teleportPlayer', { username: 'Test', x: 100.1, y: 100, z: 0 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('unverifiable');
  });

  it('a genuine single-floor (z-only) teleport still registers as a real, verified move', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub(true));
    const result = bridge.callHandler('teleportPlayer', { username: 'Test', x: 100, y: 100, z: 1 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(result.data.verifyPosition).toEqual({ x: 100, y: 100, z: 1 });
  });
});
