import { describe, expect, it } from 'vite-plus/test'
import { effectiveGamePort } from '../services/serverManager.ts'

describe('effectiveGamePort', () => {
  it('uses the profile port the panel passes as -port', () => {
    expect(effectiveGamePort({ installPath: '/srv/pz', serverPort: 26261 }, '16261')).toBe(26261)
  })

  it('falls back to the .ini when the profile keeps the default port', () => {
    expect(effectiveGamePort({ installPath: '/srv/pz', serverPort: 16261 }, '17261')).toBe(17261)
  })

  it('trusts the .ini when the panel does not write the launch', () => {
    expect(effectiveGamePort({ installPath: '/srv/pz', serverPort: 26261, startCommand: './run.sh' }, '16261')).toBe(16261)
    expect(effectiveGamePort({ installPath: '/srv/pz/start.sh', serverPort: 26261 }, '16261')).toBe(16261)
  })

  it('returns null when nothing is known', () => {
    expect(effectiveGamePort(null, undefined)).toBeNull()
  })
})
