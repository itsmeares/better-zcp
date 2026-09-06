import { describe, it, expect } from 'vitest'
import { sanitizeSteamId } from '../Players'

// conv-hunt-pages-2 lens 4, confirmed instance: apps/panel-server/routes/players.js
// requires SteamID64 to match /^\d{17}$/ on both /banid and /unbanid (400
// "Invalid SteamID format (must be 17 digits)" otherwise). The allowlist's
// SteamID field already enforced this by stripping non-digits and clamping
// to 17 chars on every keystroke, with its Add button disabled until the
// length was exactly 17 -- but its two siblings, the "Ban by SteamID" and
// "Unban by SteamID" manual-entry fields, took free text with no format
// enforcement at all and only checked non-empty before submit. Same value
// type, same server rule, two of three fields unguarded.
describe('Players -- sanitizeSteamId', () => {
  it('strips non-digit characters', () => {
    expect(sanitizeSteamId('7656-1198 0000000 00')).toBe('76561198000000000')
  })

  it('clamps to 17 digits', () => {
    expect(sanitizeSteamId('765611980000000001234')).toBe('76561198000000000')
  })

  it('leaves a valid 17-digit id untouched', () => {
    expect(sanitizeSteamId('76561198000000000')).toBe('76561198000000000')
  })
})
