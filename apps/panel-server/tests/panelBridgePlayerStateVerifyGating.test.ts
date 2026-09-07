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
