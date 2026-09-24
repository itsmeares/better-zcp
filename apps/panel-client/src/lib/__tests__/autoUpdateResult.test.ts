import { describe, expect, it } from 'vite-plus/test'
import {
  getAutoUpdateReasonMessage,
  getAutoUpdateServerStateMessage,
  getAutoUpdateSuccessMessage,
} from '../autoUpdateResult'

describe('automatic update result copy', () => {
  it('keeps the game-server state explicit after a failed panel update', () => {
    expect(getAutoUpdateServerStateMessage(true)).toBe(
      'Your server is currently running.',
    )
    expect(getAutoUpdateServerStateMessage(false)).toBe(
      'Your server is currently stopped.',
    )
  })

  it('includes structured failure details and rejects unknown reason codes safely', () => {
    expect(
      getAutoUpdateReasonMessage({
        status: 'failed',
        reason: 'STEAMCMD_EXIT_CODE',
        params: { code: 7 },
      }),
    ).toContain('code 7')
    expect(
      getAutoUpdateReasonMessage({ status: 'failed', reason: 'NEW_REASON' }),
    ).toBe('An unexpected error occurred during the automatic update.')
  })

  it('shows the applied version on success', () => {
    expect(
      getAutoUpdateSuccessMessage({
        status: 'success',
        appliedVersion: '2.1.0',
      }),
    ).toContain('2.1.0')
  })
})
