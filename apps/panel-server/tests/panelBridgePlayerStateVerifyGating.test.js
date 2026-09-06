import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage for items 4/5 of the full handler-verification audit:
// setGodMode/setInvisible already computed a `verified` read-back and threw
// it away (always returned ok=true regardless); setNoclip didn't compute one
// at all. Per the ruling: these already had (or needed) the read-back --
// the fix is gating `ok` on it, not adding new capability.
//
// Also covers a correctness bug found while making this fix: the original
// `verified = state ~= nil and (state == enabled) or nil` used Lua's
// `a and b or c` idiom, which silently breaks when b (a genuine mismatch) is
// `false` -- `true and false` short-circuits to `false`, which is falsy, so
// it falls through to c (nil). That made a CONFIRMED failure indistinguishable
// from "couldn't verify", which would have made gating on verified==false
// never actually fire. Rewritten with explicit if/then.

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

function playerStub({ godMod = false, invisible = false, noClip = false } = {}) {
  return `
FakePlayer = {
  username = "Test",
  godMod = ${godMod},
  invisible = ${invisible},
  noClip = ${noClip},
}
function FakePlayer:getUsername() return self.username end
function FakePlayer:setGodMod(v) self.godMod = v end
function FakePlayer:isGodMod() return self.godMod end
function FakePlayer:setInvisible(v) self.invisible = v end
function FakePlayer:isInvisible() return self.invisible end
function FakePlayer:setNoClip(v) self.noClip = v end
function FakePlayer:isNoClip() return self.noClip end

FakePlayerList = { FakePlayer }
function FakePlayerList:size() return 1 end
function FakePlayerList:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakePlayerList end
`;
}

// A setter that "succeeds" (doesn't throw) but never actually flips the
// underlying state -- e.g. a build where the setter is a documented no-op
// in some game state. The getter reports the real (unchanged) value.
function noOpPlayerStub(setterName, getterName, initial) {
  return `
FakePlayer = { username = "Test", state = ${initial} }
function FakePlayer:getUsername() return self.username end
function FakePlayer:${setterName}(v) end
function FakePlayer:${getterName}() return self.state end
FakePlayerList = { FakePlayer }
function FakePlayerList:size() return 1 end
function FakePlayerList:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakePlayerList end
`;
}

describe('PanelBridge.lua handlers.setGodMode/setInvisible/setNoclip -- gate ok on the real read-back', () => {
  it('setGodMode reports success and verified=true when the state actually changed', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub());
    const result = bridge.callHandler('setGodMode', { username: 'Test', enabled: true });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('setGodMode must NOT report success when the read-back confirms it did not change (this is the and/or-idiom bug)', () => {
    const bridge = loadPanelBridge(LUA_PATH, noOpPlayerStub('setGodMod', 'isGodMod', false));
    const result = bridge.callHandler('setGodMode', { username: 'Test', enabled: true });

    // Before the fix this returned ok=true with verified=nil (the and/or bug
    // masked the mismatch as "unverifiable" instead of "confirmed wrong").
    expect(result.err).not.toMatch(/Player not found/);
    expect(result.ok).toBe(false);
  });

  it('setInvisible reports success and verified=true when the state actually changed', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub());
    const result = bridge.callHandler('setInvisible', { username: 'Test', enabled: true });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('setInvisible must NOT report success when the read-back confirms it did not change', () => {
    const bridge = loadPanelBridge(LUA_PATH, noOpPlayerStub('setInvisible', 'isInvisible', false));
    const result = bridge.callHandler('setInvisible', { username: 'Test', enabled: true });

    expect(result.err).not.toMatch(/Player not found/);
    expect(result.ok).toBe(false);
  });

  it('setNoclip reports success and verified=true when the state actually changed', () => {
    const bridge = loadPanelBridge(LUA_PATH, playerStub());
    const result = bridge.callHandler('setNoclip', { username: 'Test', enabled: true });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('setNoclip must NOT report success when the read-back confirms it did not change', () => {
    const bridge = loadPanelBridge(LUA_PATH, noOpPlayerStub('setNoClip', 'isNoClip', false));
    const result = bridge.callHandler('setNoclip', { username: 'Test', enabled: true });

    expect(result.err).not.toMatch(/Player not found/);
    expect(result.ok).toBe(false);
  });
});
