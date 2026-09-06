import { describe, it, expect } from 'vitest'
import { isWorldSaveFailure } from '../ServerConfig'


describe('ServerConfig.tsx isWorldSaveFailure: reads PanelBridge.lua setSandboxOption\'s persisted/saveError contract', () => {
  it('reports a failure when persisted is explicitly false', () => {
    expect(isWorldSaveFailure({ persisted: false, saveError: 'disk full' })).toBe(true)
  })

  it('reports no failure when persisted is true', () => {
    expect(isWorldSaveFailure({ persisted: true })).toBe(false)
  })

  it('does NOT report a failure when persisted is absent (older bridge build that never sends the field)', () => {
    expect(isWorldSaveFailure({})).toBe(false)
    expect(isWorldSaveFailure(undefined)).toBe(false)
    expect(isWorldSaveFailure(null)).toBe(false)
  })
})
