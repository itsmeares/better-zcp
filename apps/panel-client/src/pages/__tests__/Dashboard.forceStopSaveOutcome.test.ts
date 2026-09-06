import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { getForceStopSaveOutcomeCopy } from '../Dashboard'

const t = i18n.getFixedT('en', 'dashboard')

describe('getForceStopSaveOutcomeCopy', () => {
  it('returns null for "saved" -- falls through to the generic success toast', () => {
    expect(getForceStopSaveOutcomeCopy(t, 'saved')).toBeNull()
  })

  it('returns null when saveOutcome is absent -- older/unexpected response shape falls through too', () => {
    expect(getForceStopSaveOutcomeCopy(t, undefined)).toBeNull()
  })

  it('gives "failed" its own copy, distinct from "timedOut"', () => {
    const failed = getForceStopSaveOutcomeCopy(t, 'failed')
    const timedOut = getForceStopSaveOutcomeCopy(t, 'timedOut')
    expect(failed).not.toBeNull()
    expect(timedOut).not.toBeNull()
    expect(failed!.title).not.toBe(timedOut!.title)
    expect(failed!.description).not.toBe(timedOut!.description)
  })

  it('"skipped" copy states why, not just that a save didn\'t happen', () => {
    const skipped = getForceStopSaveOutcomeCopy(t, 'skipped')
    expect(skipped).not.toBeNull()
    expect(skipped!.description.toLowerCase()).toContain('rcon')
  })

  it('rejects an unrecognized value instead of guessing which of the three it means', () => {
    expect(getForceStopSaveOutcomeCopy(t, 'something-new')).toBeNull()
  })
})
