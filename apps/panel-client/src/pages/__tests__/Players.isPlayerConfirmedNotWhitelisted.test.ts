import { describe, it, expect } from 'vitest'
import { isPlayerConfirmedNotWhitelisted } from '../Players'

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
