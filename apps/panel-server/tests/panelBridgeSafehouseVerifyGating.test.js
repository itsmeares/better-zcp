import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage from the deferred safehouse/faction/moderation class
// of the full handler-verification audit. All four SafeHouse mutators used
// here (addPlayer, removePlayer, setOwner, setRespawnInSafehouse) are
// declared `void` in the real B42 jar (zombie/iso/areas/SafeHouse.class,
// confirmed 2026-08-23) -- there is no direct return value. But real getters
// DO exist and were already being used elsewhere in this same file
// (handlers.getSafehouses already reads getPlayers()/getOwner()):
// getPlayers(), getOwner(), isRespawnInSafehouse(username). These fixes read
// those back and gate on them instead of assuming the void call worked.

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

function safehouseStub({ sticks = true, initialPlayers = [], initialOwner = 'Owner1', initialRespawn = {} } = {}) {
  const playersLua = initialPlayers.map((p) => `"${p}"`).join(', ');
  const respawnLua = Object.entries(initialRespawn)
    .map(([k, v]) => `["${k}"] = ${v}`)
    .join(', ');
  return `
FakeSafehouse = {
  id = "sh1",
  players = { ${playersLua} },
  owner = "${initialOwner}",
  respawn = { ${respawnLua} },
  sticks = ${sticks},
}
function FakeSafehouse:getId() return self.id end
function FakeSafehouse:getTitle() return "Test Safehouse" end
function FakeSafehouse:getPlayers()
  local list = {}
  for _, p in ipairs(self.players) do table.insert(list, p) end
  local wrapper = { items = list }
  function wrapper:size() return #self.items end
  function wrapper:get(i) return self.items[i + 1] end
  return wrapper
end
function FakeSafehouse:addPlayer(username)
  if self.sticks then table.insert(self.players, username) end
end
function FakeSafehouse:removePlayer(username)
  if self.sticks then
    for i, p in ipairs(self.players) do
      if p == username then table.remove(self.players, i) break end
    end
  end
end
function FakeSafehouse:getOwner() return self.owner end
function FakeSafehouse:setOwner(newOwner)
  if self.sticks then self.owner = newOwner end
end
function FakeSafehouse:isRespawnInSafehouse(username)
  return self.respawn[username] == true
end
function FakeSafehouse:setRespawnInSafehouse(enabled, username)
  if self.sticks then self.respawn[username] = enabled end
end

FakeSafehouseList = { FakeSafehouse }
function FakeSafehouseList:size() return 1 end
function FakeSafehouseList:get(i) return self[i + 1] end
SafeHouse = { getSafehouseList = function() return FakeSafehouseList end }
`;
}

describe('PanelBridge.lua handlers.safehouseAddPlayer/RemovePlayer/SetOwner/SetRespawn -- gate on the real read-back', () => {
  it('safehouseAddPlayer reports success and verified=true when the player is really in the list afterward', () => {
    const bridge = loadPanelBridge(LUA_PATH, safehouseStub({ sticks: true }));
    const result = bridge.callHandler('safehouseAddPlayer', { safehouseRef: 'sh1', username: 'Alice' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('safehouseAddPlayer must NOT report success when addPlayer silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, safehouseStub({ sticks: false }));
    const result = bridge.callHandler('safehouseAddPlayer', { safehouseRef: 'sh1', username: 'Alice' });

    expect(result.ok).toBe(false);
  });

  it('safehouseRemovePlayer reports success and verified=true when the player is really gone afterward', () => {
    const bridge = loadPanelBridge(LUA_PATH, safehouseStub({ sticks: true, initialPlayers: ['Alice'] }));
    const result = bridge.callHandler('safehouseRemovePlayer', { safehouseRef: 'sh1', username: 'Alice' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('safehouseRemovePlayer must NOT report success when removePlayer silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, safehouseStub({ sticks: false, initialPlayers: ['Alice'] }));
    const result = bridge.callHandler('safehouseRemovePlayer', { safehouseRef: 'sh1', username: 'Alice' });

    expect(result.ok).toBe(false);
  });

  it('safehouseSetOwner reports success and verified=true when the owner really changes', () => {
    const bridge = loadPanelBridge(LUA_PATH, safehouseStub({ sticks: true, initialOwner: 'Owner1' }));
    const result = bridge.callHandler('safehouseSetOwner', { safehouseRef: 'sh1', owner: 'Bob' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('safehouseSetOwner must NOT report success when setOwner silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, safehouseStub({ sticks: false, initialOwner: 'Owner1' }));
    const result = bridge.callHandler('safehouseSetOwner', { safehouseRef: 'sh1', owner: 'Bob' });

    expect(result.ok).toBe(false);
  });

  it('safehouseSetRespawn reports success and verified=true when the flag really changes', () => {
    const bridge = loadPanelBridge(LUA_PATH, safehouseStub({ sticks: true }));
    const result = bridge.callHandler('safehouseSetRespawn', { safehouseRef: 'sh1', username: 'Alice', enabled: true });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('safehouseSetRespawn must NOT report success when setRespawnInSafehouse silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, safehouseStub({ sticks: false }));
    const result = bridge.callHandler('safehouseSetRespawn', { safehouseRef: 'sh1', username: 'Alice', enabled: true });

    expect(result.ok).toBe(false);
  });
});
