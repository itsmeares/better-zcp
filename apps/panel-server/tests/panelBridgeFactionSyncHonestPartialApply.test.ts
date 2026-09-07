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

function factionStub({ initialMembers = [], initialTag = 'OLD' } = {}) {
  const membersLua = initialMembers.map((m) => `["${m}"] = true`).join(', ');
  return `
FakeFaction = {
  members = { ${membersLua} },
  tag = "${initialTag}",
}
function FakeFaction:isMember(username) return self.members[username] == true end
function FakeFaction:addPlayer(username) self.members[username] = true end
function FakeFaction:removePlayer(username) self.members[username] = nil end
function FakeFaction:getTag() return self.tag end
function FakeFaction:setTag(newTag) self.tag = newTag end
-- Deliberately NO syncFaction method on this stub -- it does not exist on
-- the real jar either. If PanelBridge.lua ever called it unconditionally
-- again (instead of just not calling it), invoking a nil method would throw
-- inside the mutation pcall and these handlers would report ok=false, which
-- would itself be a loud regression signal.

Faction = {
  getFaction = function(name) return FakeFaction end,
}
`;
}

describe('PanelBridge.lua faction handlers -- honest about the sync that does not happen', () => {
  it('factionAddPlayer: mutation still succeeds, but the result says plainly it was not synced to connected clients', () => {
    const bridge = loadPanelBridge(LUA_PATH, factionStub());
    const result = bridge.callHandler('factionAddPlayer', { factionName: 'Test', username: 'Alice' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(result.data.synced).toBe(false);
    expect(result.data.message).toMatch(/not (pushed|synced)/i);
  });

  it('factionRemovePlayer: mutation still succeeds, but the result says plainly it was not synced to connected clients', () => {
    const bridge = loadPanelBridge(LUA_PATH, factionStub({ initialMembers: ['Alice'] }));
    const result = bridge.callHandler('factionRemovePlayer', { factionName: 'Test', username: 'Alice' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(result.data.synced).toBe(false);
    expect(result.data.message).toMatch(/not (pushed|synced)/i);
  });

  it('factionSetTag: mutation still succeeds, but the result says plainly it was not synced to connected clients', () => {
    const bridge = loadPanelBridge(LUA_PATH, factionStub({ initialTag: 'OLD' }));
    const result = bridge.callHandler('factionSetTag', { factionName: 'Test', tag: 'NEW' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(result.data.synced).toBe(false);
    expect(result.data.message).toMatch(/not (pushed|synced)/i);
  });

  it('a faction handler that fails verification is still a clean failure, unaffected by the sync-honesty change', () => {
    const bridge = loadPanelBridge(
      LUA_PATH,
      `
FakeFaction = { tag = "OLD" }
function FakeFaction:getTag() return self.tag end
function FakeFaction:setTag(newTag) end -- deliberately does not stick
Faction = { getFaction = function(name) return FakeFaction end }
`,
    );
    const result = bridge.callHandler('factionSetTag', { factionName: 'Test', tag: 'NEW' });

    expect(result.ok).toBe(false);
  });
});
