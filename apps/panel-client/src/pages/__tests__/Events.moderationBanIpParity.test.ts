import { describe, it, expect } from 'vitest'
import en from '../../locales/en/events.json'

// bug-hunt-2026-08-26: Jim found (RCON-vs-PanelBridge comparison) that RCON
// /ban has a same-call banIp toggle (apps/panel-server/services/rcon.js banPlayer ->
// `banuser "<user>" -ip`, wired to Players.tsx's banIp checkbox), but the
// bridge's moderationBanUser operation -- the one Events.tsx's Bridge
// Operations panel offers -- has NO such capability at all, not just a
// missing UI checkbox. Verified against HEAD before touching anything:
// PanelBridge.lua's handlers.moderationBanUser calls
// `BanSystem.BanUser(username, nil, reason, ban)` with the connection
// argument HARDCODED to nil -- that argument is what the real API uses to
// resolve which IP to also ban, so this is structurally incapable of an IP
// ban, not a toggle nobody wired up. An operator banning someone from the
// Events page believes they've done what the Players page's ban does, and
// they have not -- silently.
//
// Checked whether kick has the same asymmetry (it was named alongside ban):
// it does not. Neither RCON's kickPlayer (apps/panel-server/services/rcon.js, plain
// `kickuser "<user>"`, no -ip flag exists) nor the bridge's
// moderationKickUser (BanSystem.KickUser, no IP concept in its signature at
// all) have any IP capability to begin with, so there is no parity gap to
// surface for kick.
//
// Per god's instruction: do NOT add an IP toggle to the Events path -- the
// bridge genuinely cannot do it, so that would be a feature request against
// the mod, not a bug fix. Instead, say what is true, right where the
// operator is choosing this operation: Events.tsx renders
// bridgeOperationTemplates[operation].description verbatim as the visible
// subtitle under the operation picker (see Events.tsx ~line 2760), so
// correcting that description is the actual fix. This test pins the
// corrected copy and guards against the caveat drifting onto an operation
// that doesn't need it (moderationBanIP and moderationBanSteamID ARE IP/
// SteamID bans, saying "does not ban IP" there would be wrong).

describe('Events -- moderationBanUser bridge-operation copy tells the operator it has no IP-ban parity with the Players page', () => {
  it('warns that a bridge username ban does not also ban the IP, and points at the Players page', () => {
    const description = en.operations.moderationBanUser.description
    expect(description).toMatch(/does not ban.*IP/i)
    expect(description).toMatch(/Players page/i)
  })

  it('does not put the same caveat on operations that genuinely are IP/SteamID bans', () => {
    expect(en.operations.moderationBanIP.description).not.toMatch(/does not ban/i)
    expect(en.operations.moderationBanSteamID.description).not.toMatch(/does not ban/i)
  })

  it('leaves the kick description alone -- kick has no IP capability on either side, so nothing to warn about', () => {
    expect(en.operations.moderationKickUser.description).not.toMatch(/IP/i)
  })
})
