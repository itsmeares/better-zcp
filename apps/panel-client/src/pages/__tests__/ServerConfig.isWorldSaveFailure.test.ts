import { describe, it, expect } from 'vitest'
import { isWorldSaveFailure } from '../ServerConfig'

// bug-hunt-2026-08-27 (Pam's sweep, closed here): PanelBridge.lua's
// setSandboxOption handler calls world:saveWorld() to make a live sandbox
// change durable and reports the outcome as `persisted`/`saveError`
// (b376b2c) -- added specifically to stop a failed world save from
// silently reporting success. Nothing on the client ever read those two
// fields; handleOptionChange's own persistence check
// (serverFilesApi.saveSandboxOption) is a SEPARATE call, writing
// SandboxVars.lua directly, with its own independent failure mode -- so an
// operator whose live change failed to persist via the world save, while
// the separate file write still succeeded, was told nothing had gone
// wrong. This pins the read-side contract in isolation: only an explicit
// `persisted: false` is a failure; an older bridge build that never sends
// the field at all (`persisted` absent) must NOT be misread as one, same
// old-bridge-safe handling bridgeVerify.ts already gives `verified`.

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
