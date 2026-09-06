import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage from the deferred safehouse/faction/moderation class
// of the full handler-verification audit. Faction.addPlayer/removePlayer/
// setTag are all declared void in the real B42 jar
// (zombie/characters/Faction.class, confirmed 2026-08-23), but real getters
// exist: isMember(username), getTag(). These fixes read those back and gate
// on them instead of assuming the void call worked.
//
// Faction.createFaction and faction:removeFaction were separately confirmed
// to not exist ANYWHERE in the jar (zero hits across all 23,740 class
// files) -- those two are documented with a comment, not tested here, since
// the existing guard/pcall already fails safely and honestly (no false
// success), and no functional replacement was investigated (out of scope
// for a verification-gating pass).

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

function factionStub({ sticks = true, initialMembers = [], initialTag = 'OLD' } = {}) {
  const membersLua = initialMembers.map((m) => `["${m}"] = true`).join(', ');
  return `
FakeFaction = {
  members = { ${membersLua} },
  tag = "${initialTag}",
  sticks = ${sticks},
}
function FakeFaction:isMember(username) return self.members[username] == true end
function FakeFaction:addPlayer(username)
  if self.sticks then self.members[username] = true end
end
function FakeFaction:removePlayer(username)
  if self.sticks then self.members[username] = nil end
end
function FakeFaction:getTag() return self.tag end
function FakeFaction:setTag(newTag)
  if self.sticks then self.tag = newTag end
end

Faction = {
  getFaction = function(name) return FakeFaction end,
}
`;
}

describe('PanelBridge.lua handlers.factionAddPlayer/RemovePlayer/SetTag -- gate on the real read-back', () => {
  it('factionAddPlayer reports success and verified=true when the player is really a member afterward', () => {
    const bridge = loadPanelBridge(LUA_PATH, factionStub({ sticks: true }));
    const result = bridge.callHandler('factionAddPlayer', { factionName: 'Test', username: 'Alice' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('factionAddPlayer must NOT report success when addPlayer silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, factionStub({ sticks: false }));
    const result = bridge.callHandler('factionAddPlayer', { factionName: 'Test', username: 'Alice' });

    expect(result.ok).toBe(false);
  });

  it('factionRemovePlayer reports success and verified=true when the player is really gone afterward', () => {
    const bridge = loadPanelBridge(LUA_PATH, factionStub({ sticks: true, initialMembers: ['Alice'] }));
    const result = bridge.callHandler('factionRemovePlayer', { factionName: 'Test', username: 'Alice' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('factionRemovePlayer must NOT report success when removePlayer silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, factionStub({ sticks: false, initialMembers: ['Alice'] }));
    const result = bridge.callHandler('factionRemovePlayer', { factionName: 'Test', username: 'Alice' });

    expect(result.ok).toBe(false);
  });

  it('factionSetTag reports success and verified=true when the tag really changes', () => {
    const bridge = loadPanelBridge(LUA_PATH, factionStub({ sticks: true, initialTag: 'OLD' }));
    const result = bridge.callHandler('factionSetTag', { factionName: 'Test', tag: 'NEW' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('factionSetTag must NOT report success when setTag silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, factionStub({ sticks: false, initialTag: 'OLD' }));
    const result = bridge.callHandler('factionSetTag', { factionName: 'Test', tag: 'NEW' });

    expect(result.ok).toBe(false);
  });
});
