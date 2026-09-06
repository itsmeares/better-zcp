import { describe, it, expect } from 'vitest'
import { isValidGamePort, isValidPort } from '../Servers'

describe('Servers -- isValidPort', () => {
  it('rejects ports outside 1-65535, matching the server-side range check', () => {
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(-1)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(99999)).toBe(false)
    expect(isValidPort(NaN)).toBe(false)
  })

  it('accepts ports within 1-65535', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(27015)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
    expect(isValidPort(1.5)).toBe(false)
  })
})

describe('Servers -- isValidGamePort', () => {
  it('rejects 65535 because the derived UDP port would be invalid', () => {
    expect(isValidGamePort(65535)).toBe(false)
    expect(isValidGamePort(65534)).toBe(true)
  })
})
