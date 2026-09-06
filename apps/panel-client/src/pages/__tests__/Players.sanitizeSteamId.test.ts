import { describe, it, expect } from 'vitest'
import { sanitizeSteamId } from '../Players'

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
