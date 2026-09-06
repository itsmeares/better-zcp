import { describe, it, expect } from 'vitest'
import { installationErrorGuidance } from '../ServerSetup'

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
