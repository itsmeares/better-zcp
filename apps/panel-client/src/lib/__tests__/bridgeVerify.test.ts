import { describe, expect, it } from 'vitest'
import { getBridgeVerifiedState, VERIFY_GATED_ACTIONS } from '../bridgeVerify'

// The three-state contract god ruled on 2026-08-23 (conv-success-checker):
// verified is a STRING, always present when ok=true for a verify-gated
// action -- "confirmed" (real read-back matched), "unverifiable" (call
// succeeded, no read-back exists -- NOT a failure), or the key missing
// entirely, which means an out-of-date bridge mod (predates the contract),
// not "unconfirmed". Deliberately NOT a boolean: absence collapsing "old
// bridge" and "can't confirm" into one non-signal is the exact failure
// shape god rejected the field for (same class as the SERVER_STATE_UNKNOWN
// bug fixed earlier the same night).
describe('getBridgeVerifiedState', () => {
  it('returns null for an action that was never verify-gated, regardless of the data shape', () => {
    expect(getBridgeVerifiedState('healPlayer', { verified: 'confirmed' })).toBeNull()
    expect(getBridgeVerifiedState('vehicleRepair', undefined)).toBeNull()
    expect(getBridgeVerifiedState('triggerAirdrop', null)).toBeNull()
    // Even a stray boolean/legacy value on a non-gated action doesn't matter
    // -- the action gate is checked first, before the value is ever read.
    expect(getBridgeVerifiedState('vehicleHotwire', { verified: true })).toBeNull()
  })

  it('returns "confirmed" only for the exact string "confirmed" on a gated action', () => {
    expect(getBridgeVerifiedState('setGodMode', { verified: 'confirmed' })).toBe('confirmed')
    expect(getBridgeVerifiedState('teleportPlayer', { verified: 'confirmed' })).toBe('confirmed')
  })

  it('returns "unverifiable" for the exact string "unverifiable" on a gated action', () => {
    expect(getBridgeVerifiedState('setInvisible', { verified: 'unverifiable' })).toBe('unverifiable')
  })

  it('returns "old-bridge" when the key is missing entirely on a gated action', () => {
    expect(getBridgeVerifiedState('setNoclip', {})).toBe('old-bridge')
    expect(getBridgeVerifiedState('setNoclip', undefined)).toBe('old-bridge')
    expect(getBridgeVerifiedState('setNoclip', null)).toBe('old-bridge')
  })

  it('returns "old-bridge" for a pre-contract boolean/nil value on a gated action -- not "confirmed" and not "unverifiable"', () => {
    // Old shipped shape before the string-contract rename: verified was a
    // plain boolean or nil. Neither `true` nor `false` is the literal string
    // "confirmed"/"unverifiable", so both correctly fall through to
    // old-bridge -- exactly the intended signal for a mod that predates
    // this contract, not a false "confirmed".
    expect(getBridgeVerifiedState('setGodMode', { verified: true })).toBe('old-bridge')
    expect(getBridgeVerifiedState('setGodMode', { verified: false })).toBe('old-bridge')
  })

  it('every action in the gated set is a real, exact Lua handler action name (spot-check against the authoritative list)', () => {
    // Not exhaustive against the Lua source from a client-side test, but
    // guards against a typo silently turning a gated action into a
    // permanently-null (never-checked) one.
    const expected = [
      'teleportPlayer',
      'setSandboxOption',
      'setGodMode',
      'setInvisible',
      'setNoclip',
      'spawnHordeNearPlayer',
      'spawnHordeBehindPlayer',
      'safehouseAddPlayer',
      'safehouseRemovePlayer',
      'safehouseSetOwner',
      'safehouseSetRespawn',
      'factionAddPlayer',
      'factionRemovePlayer',
      'factionSetTag',
      'vehicleSetAlarm',
      'vehicleSetSiren',
      'vehicleSetTrunkLocked',
      'vehicleSetFuel',
      'vehicleSetBattery',
      'moderationBanUser',
      'moderationBanIP',
      'moderationBanSteamID',
    ]
    expect([...VERIFY_GATED_ACTIONS].sort()).toEqual([...expected].sort())
  })
})
