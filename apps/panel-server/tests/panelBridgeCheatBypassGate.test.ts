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
