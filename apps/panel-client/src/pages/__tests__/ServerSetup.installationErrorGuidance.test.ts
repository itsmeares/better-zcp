import { describe, it, expect } from 'vitest'
import { installationErrorGuidance } from '../ServerSetup'

// 2026-08-27, no-raw-error-lint-rule-only-matches-the-toast-shape sweep:
// ServerSetup.tsx's catch block used to compute rawMessage via the bare
// `error instanceof Error ? error.message : fallback` ternary, feed it into
// this function, and display whatever it returned -- invisible to
// no-raw-error-message.js because the ternary fed a function call, not a
// toast()/set*() argument directly (a TWO-HOP indirection, one hop further
// than the one-hop variable-flow check that same sweep added). For every
// installation error OTHER than "path not writable", this function just
// returned its input unchanged, so any coded/translatable error showed the
// server's fully raw English text with no translation. Fixed by splitting
// the single `message` parameter into `rawMessage` (kept raw ON PURPOSE,
// via rawErrorMessageIntentional -- needed to pattern-match the server's
// literal string and to embed the exact unwritable path in the Linux
// guidance suffix, the same "raw text for internal logic" use
// errorMessage.ts's own getRecoveryUrl() has) and `displayMessage` (routed
// through getUserErrorMessage() -- what actually reaches the user for
// every OTHER installation error).
const t = (key: string, opts?: Record<string, unknown>) =>
  key === 'toasts.installationErrorGuidance'
    ? `${opts?.message} -- see ${opts?.path} on the host and restart the service`
    : key

describe('ServerSetup -- installationErrorGuidance', () => {
  it('returns displayMessage unchanged for an installation error that is not the writable-path one, regardless of platform', () => {
    expect(
      installationErrorGuidance('SteamCMD exited with code 7', 'SteamCMD download failed (translated)', t, 'linux'),
    ).toBe('SteamCMD download failed (translated)')
    expect(
      installationErrorGuidance('SteamCMD exited with code 7', 'SteamCMD download failed (translated)', t, 'win32'),
    ).toBe('SteamCMD download failed (translated)')
  })

  it('returns displayMessage unchanged for the writable-path error on a non-Linux platform -- the systemd advice would be unfollowable there', () => {
    expect(
      installationErrorGuidance(
        'Installation path is not writable: /srv/pz',
        'Installation path is not writable (translated)',
        t,
        'win32',
      ),
    ).toBe('Installation path is not writable (translated)')
    expect(
      installationErrorGuidance(
        'Installation path is not writable: /srv/pz',
        'Installation path is not writable (translated)',
        t,
        null,
      ),
    ).toBe('Installation path is not writable (translated)')
  })

  it('embeds the RAW path (not displayMessage) into the Linux guidance suffix -- the whole point is the exact unwritable path, which a translation would not preserve verbatim', () => {
    const result = installationErrorGuidance(
      'Installation path is not writable: /srv/pz',
      'Installation path is not writable (translated, and this must NOT appear below)',
      t,
      'linux',
    )
    expect(result).toContain('Installation path is not writable: /srv/pz')
    expect(result).toContain('/opt/zomboid-panel/data/pzserver')
    expect(result).not.toContain('translated, and this must NOT appear below')
  })
})
