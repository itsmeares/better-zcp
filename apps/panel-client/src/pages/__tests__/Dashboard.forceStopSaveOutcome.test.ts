import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { getForceStopSaveOutcomeCopy } from '../Dashboard'

// Force Stop now attempts a bounded, fail-open save before killing the
// server (server.js's attemptBoundedSaveBeforeForceStop) and reports the
// outcome as saveOutcome -- but Dashboard's success toast used to be a
// static, response-independent string, so a failed/timed-out/skipped save
// was reported identically to a genuine one. This is the highest-stakes
// instance of that class tonight: it's the one thing an operator needs to
// know after force-stopping a server. Proving the four states render
// distinctly, not just reviewing the switch statement.
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
