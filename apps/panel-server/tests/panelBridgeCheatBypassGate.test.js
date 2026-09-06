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

// GitHub issue #129 (Tiboriuss): setNoclip/setGodMode/setInvisible complete
// with no error, but the target's state never actually changes. Confirmed by
// reading the real B42 jar bytecode (2026-08-30/31, javap -c): the 1-arg
// setter checks the TARGET's own Role capability (ToggleNoclipHimself /
// ...GodModHimself / ...InvisibleHimself) and, when it's absent -- true for
// every ordinary player, since those capabilities exist for an admin
// toggling their OWN debug cheats -- it ACTIVELY WRITES false one
// instruction before returning. It doesn't merely leave the value alone. The
// 2-arg overload (value, true) skips that check and makes the same
// underlying getCheats():set(...) write the gated 1-arg path makes when it
// passes -- confirmed from the same bytecode, and confirmed that Lua's 2-arg
// call actually REACHES that overload rather than truncating to the 1-arg
// form (Kahlua's MultiLuaJavaInvoker dispatch). PanelBridge.setCharacterCheatBypassingRoleGate()
// is the fix: try the 2-arg bypass first, fall back to the 1-arg form only
// for a build that lacks the overload entirely (true for setInvincible on
// this build -- no bypass is possible there; left alone with a comment
// rather than a fake workaround).
//
// This is a real, separate gap from panelBridgePlayerStateVerifyGating.test.js:
// that file covers the setGodMode/setInvisible/setNoclip HANDLERS' read-back
// verification, but setCharacterCheatBypassingRoleGate() itself -- the
// actual #129 fix -- had zero direct coverage. A plain Lua stub accepting
// any number of arguments can't fail to exercise the bypass branch (Lua
// silently discards extra arguments to a function that doesn't declare
// them), so those handler tests never distinguished "the 2-arg bypass
// worked" from "the 1-arg gate happened to pass" -- these do, by modelling
// the jar's actual arity-sensitive, gate-forces-false contract.

// Models the real per-target Role-capability gate found in the jar: called
// with a non-nil 2nd (bypass) argument, the check is skipped and the real
// value is written; called with exactly 1 argument, the gate is "closed" for
// an ordinary player and the write is FORCED to false regardless of v.
function gatedPlayer() {
  return `
FakePlayer = { username = "Test", state = false }
function FakePlayer:getUsername() return self.username end
function FakePlayer:isNoClip() return self.state end
function FakePlayer:setNoClip(v, bypass)
  if bypass ~= nil then
    self.state = v
  else
    self.state = false
  end
end
FakePlayerList = { FakePlayer }
function FakePlayerList:size() return 1 end
function FakePlayerList:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakePlayerList end
`;
}

// Models a build with NO 2-arg overload at all -- setInvincible's real
// situation on this build: any extra argument raises, the same way calling
// a Java method with an arity the class does not declare would.
function overloadlessGatedPlayer() {
  return `
FakePlayer = { username = "Test", state = false }
function FakePlayer:getUsername() return self.username end
function FakePlayer:isNoClip() return self.state end
function FakePlayer:setNoClip(v, bypass)
  if bypass ~= nil then error("bad argument #2 to 'setNoClip' (no matching overload)") end
  self.state = false
end
FakePlayerList = { FakePlayer }
function FakePlayerList:size() return 1 end
function FakePlayerList:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakePlayerList end
`;
}

describe('PanelBridge.setCharacterCheatBypassingRoleGate -- GitHub #129, the actual fix', () => {
  it('the 2-arg bypass reaches the real write, not the gated forced-false', () => {
    const bridge = loadPanelBridge(LUA_PATH, gatedPlayer());
    bridge.run(`
      local player = getOnlinePlayers():get(0)
      __BYPASS_OK = PanelBridgeModule.setCharacterCheatBypassingRoleGate(player, "setNoClip", true)
      __STATE_AFTER = player:isNoClip()
    `);
    expect(bridge.getGlobal('__BYPASS_OK')).toBe(true);
    expect(bridge.getGlobal('__STATE_AFTER')).toBe(true);
  });

  it('a naive 1-arg call (what the code did before the fix) demonstrates the bug: the gate forces false', () => {
    const bridge = loadPanelBridge(LUA_PATH, gatedPlayer());
    bridge.run(`
      local player = getOnlinePlayers():get(0)
      player:setNoClip(true)
      __STATE_AFTER = player:isNoClip()
    `);
    expect(bridge.getGlobal('__STATE_AFTER')).toBe(false);
  });

  it('falls back to the 1-arg form when no 2-arg overload exists, without throwing', () => {
    const bridge = loadPanelBridge(LUA_PATH, overloadlessGatedPlayer());
    bridge.run(`
      local player = getOnlinePlayers():get(0)
      __BYPASS_OK = PanelBridgeModule.setCharacterCheatBypassingRoleGate(player, "setNoClip", true)
      __STATE_AFTER = player:isNoClip()
    `);
    // The CALL itself still "succeeds" (the 1-arg fallback doesn't throw) --
    // it's the underlying WRITE that's gated, not the call. This is exactly
    // why the handlers' own read-back verification
    // (panelBridgePlayerStateVerifyGating.test.js) is what actually surfaces
    // a build lacking the overload to the operator, not this function's
    // return value alone.
    expect(bridge.getGlobal('__BYPASS_OK')).toBe(true);
    expect(bridge.getGlobal('__STATE_AFTER')).toBe(false);
  });

  it('reports failure cleanly when the method does not exist on the player object at all', () => {
    const bridge = loadPanelBridge(LUA_PATH, gatedPlayer());
    bridge.run(`
      local player = getOnlinePlayers():get(0)
      __BYPASS_OK = PanelBridgeModule.setCharacterCheatBypassingRoleGate(player, "setSomeNonexistentCheat", true)
    `);
    expect(bridge.getGlobal('__BYPASS_OK')).toBe(false);
  });
});
