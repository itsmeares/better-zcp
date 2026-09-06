import { describe, it, expect } from 'vitest'
import { resolveServerConfigDeepLink } from '../ServerConfig'

// mods-unresolved-2026-08-31: resolveServerConfigDeepLink parses the
// unresolvedCause=modId|cause|suggestion transport Debug.tsx's
// getDiagnosticsFixAction mods.resolved case writes, so the unresolvedReview
// banner can say WHY each Mods= entry failed instead of just listing it.
function params(pairs: Array<[string, string]>) {
  const sp = new URLSearchParams()
  for (const [k, v] of pairs) sp.append(k, v)
  return sp
}

describe('resolveServerConfigDeepLink: unresolvedCause triage parsing', () => {
  it('attaches a typo cause with its suggestion to the matching modId', () => {
    const result = resolveServerConfigDeepLink(
      params([
        ['unresolved', 'Footprnt'],
        ['unresolvedCause', 'Footprnt|typo|Footprint'],
      ]),
    )
    expect(result.unresolvedTriage.get('Footprnt')).toEqual({
      cause: 'typo',
      suggestion: 'Footprint',
    })
  })

  it('attaches a cause with no suggestion (stillDownloading/workshopNotOnDisk/absent) without a suggestion field', () => {
    const result = resolveServerConfigDeepLink(
      params([
        ['unresolved', 'Quartermaster'],
        ['unresolvedCause', 'Quartermaster|stillDownloading|'],
      ]),
    )
    expect(result.unresolvedTriage.get('Quartermaster')).toEqual({
      cause: 'stillDownloading',
    })
  })

  it('drops a triage entry whose modId is not in the unresolved list (does not trust a hand-edited URL)', () => {
    const result = resolveServerConfigDeepLink(
      params([
        ['unresolved', 'Footprint'],
        ['unresolvedCause', 'SomeOtherModId|absent|'],
      ]),
    )
    expect(result.unresolvedTriage.size).toBe(0)
  })

  it('drops a triage entry with an unrecognized cause instead of trusting it verbatim', () => {
    const result = resolveServerConfigDeepLink(
      params([
        ['unresolved', 'Footprint'],
        ['unresolvedCause', 'Footprint|somethingNewTheServerAdded|'],
      ]),
    )
    expect(result.unresolvedTriage.size).toBe(0)
  })

  it('leaves unresolvedTriage empty when the URL carries unresolved ids but no unresolvedCause (older deep-link, pre-fix)', () => {
    const result = resolveServerConfigDeepLink(params([['unresolved', 'Footprint']]))
    expect(result.unresolved).toEqual(['Footprint'])
    expect(result.unresolvedTriage.size).toBe(0)
  })
})
