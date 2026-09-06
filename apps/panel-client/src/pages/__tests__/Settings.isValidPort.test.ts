import { describe, it, expect } from 'vitest'
import { isValidPort } from '../Settings'

describe('Settings -- isValidPort', () => {
  it('rejects ports outside 1-65535', () => {
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(-1)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(99999)).toBe(false)
    expect(isValidPort(NaN)).toBe(false)
  })

  it('accepts ports within 1-65535', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(3001)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
  })
})
