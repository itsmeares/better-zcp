import { describe, it, expect } from 'vitest'
import { getUnpersistedSandboxKeys } from '../ServerConfig'

describe('ServerConfig.tsx getUnpersistedSandboxKeys: reads PUT /sandbox\'s unpersistedKeys diagnostic', () => {
  it('returns the keys when the route reports some did not persist', () => {
    expect(getUnpersistedSandboxKeys({ unpersistedKeys: ['ZombieConfig.speed', 'Foraging'] })).toEqual([
      'ZombieConfig.speed',
      'Foraging',
    ])
  })

  it('returns null when unpersistedKeys is an empty array (everything persisted)', () => {
    expect(getUnpersistedSandboxKeys({ unpersistedKeys: [] })).toBeNull()
  })

  it('returns null when unpersistedKeys is absent (normal successful save)', () => {
    expect(getUnpersistedSandboxKeys({})).toBeNull()
    expect(getUnpersistedSandboxKeys(undefined)).toBeNull()
    expect(getUnpersistedSandboxKeys(null)).toBeNull()
  })
})
