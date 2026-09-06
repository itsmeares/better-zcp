import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage for item 3 of the full handler-verification audit:
// teleportPlayer already computed verifyPosition (the real post-teleport
// x/y/z) specifically because the code's own comment says "teleportTo alone
// does not always stick on B42 dedicated servers" -- but never compared it
// to the requested target before returning ok=true.
//
// Per god's ruling, the gate is NOT "how close to the target counts as
// arrived" (ground snap / z-level resolution / tile centring can legitimately
// shift the landing spot, and gating on that would manufacture false
// failures). It's "did the player move at all, given how far they were
// asked to move" -- comparing distance-moved-from-origin against
// distance-requested. A short teleport (origin and target close together) is
// explicitly reported unverified rather than guessed at.

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

    // Before the fix, this returned ok=true with verifyPosition sitting at
    // the untouched origin (100,100,0) while newPosition claimed (5000,6000,0).
    expect(result.ok).toBe(false);
    // verifyPosition must still be present on failure -- the operator needs
    // to see where the player actually is regardless of the verdict.
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
