import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage from the deferred safehouse/faction/moderation class
// of the full handler-verification audit. god's instruction: for each
// handler, verify whether a real read-back exists in the actual B42 API
// (don't assume) before deciding whether to gate.
//
// BanSystem.BanUser/BanIP/BanUserBySteamID all return a Java String
// (confirmed 2026-08-23 by reading zombie/network/BanSystem.class's method
// table directly: e.g. BanUser(String,UdpConnection,String,Z)Ljava/lang/String;).
// The method's own bytecode string constants contain literal rejection
// messages -- "You don't have capability to ban/unban users." and "This
// user can't be banned." -- alongside an empty string on the success path.
// This return value was already being captured as `resultOrErr`/`details`
// and thrown away without gating `ok` on it -- same shape as setGodMode's
// discarded `verified` before that fix.
//
// BanSystem.KickUser is declared `void` in the same jar -- there is no
// return value to read back at all, so moderationKickUser is unchanged
// (comment-only) and has no dedicated regression test here.

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

function banSystemStub({ banUser, banIP, banSteamID }) {
  return `
BanSystem = {
  BanUser = function(username, conn, reason, ban) return ${JSON.stringify(banUser)} end,
  BanIP = function(ip, conn, reason, ban) return ${JSON.stringify(banIP)} end,
  BanUserBySteamID = function(steamId, conn, reason, ban) return ${JSON.stringify(banSteamID)} end,
}
`;
}

describe('PanelBridge.lua handlers.moderationBanUser/BanIP/BanSteamID -- gate ok on the returned String', () => {
  it('moderationBanUser reports success when BanSystem.BanUser returns empty string', () => {
    const bridge = loadPanelBridge(LUA_PATH, banSystemStub({ banUser: '', banIP: '', banSteamID: '' }));
    const result = bridge.callHandler('moderationBanUser', { username: 'Griefer', reason: 'test' });

    expect(result.ok).toBe(true);
    expect(result.data.message).toBe('User banned');
  });

  it('moderationBanUser must NOT report success when BanSystem.BanUser returns a rejection message', () => {
    const bridge = loadPanelBridge(LUA_PATH, banSystemStub({
      banUser: "You don't have capability to ban/unban users.",
      banIP: '',
      banSteamID: '',
    }));
    const result = bridge.callHandler('moderationBanUser', { username: 'Griefer', reason: 'test' });

    // Before the fix this returned ok=true with the rejection message sitting
    // unused in `details`, reporting "User banned" for a ban that never happened.
    expect(result.ok).toBe(false);
    expect(result.err).toContain("You don't have capability");
  });

  it('moderationBanIP reports success when BanSystem.BanIP returns empty string', () => {
    const bridge = loadPanelBridge(LUA_PATH, banSystemStub({ banUser: '', banIP: '', banSteamID: '' }));
    const result = bridge.callHandler('moderationBanIP', { ip: '1.2.3.4', reason: 'test' });

    expect(result.ok).toBe(true);
    expect(result.data.message).toBe('IP banned');
  });

  it('moderationBanIP must NOT report success when BanSystem.BanIP returns a rejection message', () => {
    const bridge = loadPanelBridge(LUA_PATH, banSystemStub({
      banUser: '',
      banIP: "This user can't be banned.",
      banSteamID: '',
    }));
    const result = bridge.callHandler('moderationBanIP', { ip: '1.2.3.4', reason: 'test' });

    expect(result.ok).toBe(false);
    expect(result.err).toContain("can't be banned");
  });

  it('moderationBanSteamID reports success when BanSystem.BanUserBySteamID returns empty string', () => {
    const bridge = loadPanelBridge(LUA_PATH, banSystemStub({ banUser: '', banIP: '', banSteamID: '' }));
    const result = bridge.callHandler('moderationBanSteamID', { steamId: '765611', reason: 'test' });

    expect(result.ok).toBe(true);
    expect(result.data.message).toBe('SteamID banned');
  });

  it('moderationBanSteamID must NOT report success when BanSystem.BanUserBySteamID returns a rejection message', () => {
    const bridge = loadPanelBridge(LUA_PATH, banSystemStub({
      banUser: '',
      banIP: '',
      banSteamID: "This user can't be banned.",
    }));
    const result = bridge.callHandler('moderationBanSteamID', { steamId: '765611', reason: 'test' });

    expect(result.ok).toBe(false);
    expect(result.err).toContain("can't be banned");
  });
});
