import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, total-audit lens (return-contract sweep) -- flagged by god
// before Jim's first client call site for killPlayer shipped, so this
// mattered before anyone could observe it live.
//
// handlers.killPlayer used to end with `return isDead, { message = ...,
// username, isDead, debug }` -- when the kill did not stick, isDead is
// false, so ok=false, but the THIRD slot (the error string every other
// handler's failure path fills) was never returned at all, so the
// dispatcher forwards a null error to the panel. The actual reason
// ("player may respawn if not dead") was sitting in data.message, a field
// the failure path never surfaces.
//
// WORSE: it is also a mutate-then-fail case, same class as the faction
// handlers fixed the same night. setGodMod(false)/setInvincible(false) run
// unconditionally BEFORE Kill(nil) and the isDead check -- so a failed kill
// has already stripped the player's godmode/invincibility, and the old
// code reported that failure with no reason and no mention of what already
// landed. teleportPlayer is the shape this now copies: a real error string
// in the third slot, plus diagnostic data.

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

function playerStub({ killSticks = true, dead = null } = {}) {
  // dead overrides isDead() explicitly; otherwise it tracks whether Kill()
  // was actually invoked and "stuck".
  return `
FakePlayer = {
  username = "Test",
  godMod = true,
  invincible = true,
  killed = false,
}
function FakePlayer:getUsername() return self.username end
function FakePlayer:setGodMod(v) self.godMod = v end
function FakePlayer:setInvincible(v) self.invincible = v end
function FakePlayer:Kill(x)
  if ${killSticks} then self.killed = true end
  return true
end
function FakePlayer:isDead()
  ${dead === null ? 'return self.killed' : `return ${dead}`}
end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;
}

describe('PanelBridge.lua handlers.killPlayer -- failure path tells the truth', () => {
  it('successful kill: ok=true, isDead=true, no error', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub({ killSticks: true }));
    const result = bridge.callHandler('killPlayer', { username: 'Test' });

    expect(result.ok).toBe(true);
    expect(result.data.isDead).toBe(true);
    expect(result.err).toBeFalsy();
  });

  it('kill did not stick: ok=false with a REAL error string, not null', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub({ killSticks: false }));
    const result = bridge.callHandler('killPlayer', { username: 'Test' });

    expect(result.ok).toBe(false);
    expect(result.err).toBeTruthy();
    expect(typeof result.err).toBe('string');
    expect(result.err).toMatch(/not dead/i);
  });

  it('failed kill: the error string names the mutate-then-fail hazard -- godmode/invincibility were already stripped', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub({ killSticks: false }));
    const result = bridge.callHandler('killPlayer', { username: 'Test' });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/godmode|invincib/i);
    expect(result.err).toMatch(/not restored/i);

    // The mutation itself really did happen, confirmed against the fake's
    // own state -- this isn't just a claim in the message.
    expect(bridge.getGlobal('FakePlayer').godMod).toBe(false);
    expect(bridge.getGlobal('FakePlayer').invincible).toBe(false);
  });

  it('failed kill still returns diagnostic data (username, isDead, debug) alongside the error, not nil data', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub({ killSticks: false }));
    const result = bridge.callHandler('killPlayer', { username: 'Test' });

    expect(result.ok).toBe(false);
    expect(result.data).toBeTruthy();
    expect(result.data.username).toBe('Test');
    expect(result.data.isDead).toBe(false);
  });
});
