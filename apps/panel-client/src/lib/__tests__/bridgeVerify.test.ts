import { describe, expect, it } from 'vitest'
import { getBridgeVerifiedState, VERIFY_GATED_ACTIONS } from '../bridgeVerify'

describe('getBridgeVerifiedState', () => {
  it('returns null for an action that was never verify-gated, regardless of the data shape', () => {
    expect(getBridgeVerifiedState('healPlayer', { verified: 'confirmed' })).toBeNull()
    expect(getBridgeVerifiedState('vehicleRepair', undefined)).toBeNull()
    expect(getBridgeVerifiedState('triggerAirdrop', null)).toBeNull()
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
    expect(getBridgeVerifiedState('setGodMode', { verified: true })).toBe('old-bridge')
    expect(getBridgeVerifiedState('setGodMode', { verified: false })).toBe('old-bridge')
  })

  it('every action in the gated set is a real, exact Lua handler action name (spot-check against the authoritative list)', () => {
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
