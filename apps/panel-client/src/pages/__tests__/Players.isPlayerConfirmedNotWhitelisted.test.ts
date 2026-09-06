import { describe, it, expect } from 'vitest'
import { isPlayerConfirmedNotWhitelisted } from '../Players'

// bug-hunt-2026-08-26: "Remove from whitelist" (dossier dropdown) called
// playersApi.removeFromWhitelist(selectedPlayer) unconditionally, regardless
// of whether the selected player was actually on the whitelist -- unlike its
// sibling on the whitelist tab, which only ever targets a known member of
// the rendered list. This gate must fail OPEN (leave the control enabled)
// whenever the whitelist hasn't been confirmed loaded, since a wrong disable
// costs a real capability (can't remove someone who genuinely is
// whitelisted) while a wrong enable costs one failed click -- the opposite
// economics from a fail-closed capability/version check.
describe('Players -- isPlayerConfirmedNotWhitelisted', () => {
  const accounts = [{ username: 'Alice' }, { username: 'Bob' }]

  it('confirms not-whitelisted once loaded successfully and the player is absent', () => {
    expect(isPlayerConfirmedNotWhitelisted('Carol', accounts, false, null)).toBe(true)
  })

  it('does not confirm when the player is present', () => {
    expect(isPlayerConfirmedNotWhitelisted('Alice', accounts, false, null)).toBe(false)
  })

  it('fails open while the fetch is still in flight', () => {
    expect(isPlayerConfirmedNotWhitelisted('Carol', accounts, true, null)).toBe(false)
  })

  it('fails open when the fetch failed', () => {
    expect(isPlayerConfirmedNotWhitelisted('Carol', accounts, false, 'network error')).toBe(false)
  })

  it('fails open when no player is selected', () => {
    expect(isPlayerConfirmedNotWhitelisted(null, accounts, false, null)).toBe(false)
  })

  it('confirms not-whitelisted against a genuinely empty, successfully-loaded whitelist', () => {
    expect(isPlayerConfirmedNotWhitelisted('Carol', [], false, null)).toBe(true)
  })
})
