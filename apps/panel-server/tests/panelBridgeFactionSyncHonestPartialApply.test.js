import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, operator ruling on bridge-syncfaction-does-not-exist-silent-
// partial-apply: factionAddPlayer/factionRemovePlayer/factionSetTag each
// perform a real mutation (addPlayer/removePlayer/setTag -- all confirmed
// present and working in the real B42 jar) and then used to call
// PanelBridge.invoke(faction, "syncFaction") -- a method that does not exist
// ANYWHERE on zombie.characters.Faction or its superclass chain (Kevin's jar
// audit, 2026-08-30, confirmed with a constant-pool scan for every
// sync/transmit/propagate/broadcast/update spelling, not just a guessed-name
// miss). invoke() swallows a missing method as a clean (false, error) rather
// than throwing, and the old code never checked that return value at all --
// so the mutation landed for real, the sync silently never happened, and the
// handler still reported a clean success.
//
// The real client-sync path for a faction change turned out to be a network
// packet handler unreachable from ANY Lua (client or server -- confirmed by
// grepping the entire shipped media/lua tree for every packet class/method
// name involved: zero hits). So there is no real propagation mechanism this
// file is allowed to call instead (the operator explicitly forbade inventing
// one that was not verified to exist). The fix is honesty, not a new
// mechanism: the dead syncFaction call is gone, and the response now says
// plainly that the change applied locally and was not pushed to already-
// connected clients, via a `synced: false` field and a message that says so
// -- instead of a message indistinguishable from a fully-propagated success.
//
// These tests do not re-prove the mutation/verification behaviour already
// covered by panelBridgeFactionVerifyGating.test.js -- they prove the NEW
// honesty contract specifically: `synced` is present and false, and the
// message no longer claims an unqualified success.

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
