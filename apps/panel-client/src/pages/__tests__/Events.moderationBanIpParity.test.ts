import { describe, it, expect } from 'vitest'
import en from '../../locales/en/events.json'


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
