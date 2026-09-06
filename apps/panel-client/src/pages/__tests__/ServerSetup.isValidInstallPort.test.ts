import { describe, it, expect } from 'vitest'
import { isValidGamePort, isValidInstallPort } from '../ServerSetup'

describe('ServerSetup -- isValidInstallPort', () => {
  it('rejects ports outside 1024-65535, matching requireIntInRange on the server', () => {
    expect(isValidInstallPort(0)).toBe(false)
    expect(isValidInstallPort(1023)).toBe(false)
    expect(isValidInstallPort(80)).toBe(false)
    expect(isValidInstallPort(65536)).toBe(false)
    expect(isValidInstallPort(NaN)).toBe(false)
  })

  it('accepts ports within 1024-65535', () => {
    expect(isValidInstallPort(1024)).toBe(true)
    expect(isValidInstallPort(27015)).toBe(true)
    expect(isValidInstallPort(65535)).toBe(true)
  })
})

describe('isValidInstallPort composes with NumberInput leaving a cleared field as NaN', () => {
  it('a field the operator emptied is indistinguishable, to this check, from any other invalid port', () => {
    const clearedField = NaN
    expect(isValidInstallPort(clearedField)).toBe(isValidInstallPort(999999))
  })
})

describe('ServerSetup -- isValidGamePort', () => {
  it('rejects 65535 because the derived UDP port would overflow', () => {
    expect(isValidGamePort(65535)).toBe(false)
    expect(isValidGamePort(65534)).toBe(true)
  })
})
