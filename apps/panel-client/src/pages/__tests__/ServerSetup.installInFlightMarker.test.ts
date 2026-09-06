import { describe, it, expect, beforeEach } from 'vitest'
import {
  INSTALL_INFLIGHT_KEY,
  readInstallInFlightMarker,
  writeInstallInFlightMarker,
  clearInstallInFlightMarker,
} from '../ServerSetup'

// 2026-08-26 install-failure hunt, finding #7: install:complete/install:log
// are heard by exactly one file in the whole client (ServerSetup.tsx itself)
// -- so a tab closed or reloaded mid-download loses the eventual outcome
// entirely, with no persisted state anywhere to say an install was even
// attempted. This marker is the fix's client half: write it the instant a
// real install request is accepted, read it back on the next mount, clear it
// the instant a real outcome (success OR failure) is heard.
describe('ServerSetup -- install in-flight marker', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips a marker through localStorage', () => {
    writeInstallInFlightMarker({ installPath: '/srv/pz', serverName: 'myserver', startedAt: 1000 })
    expect(readInstallInFlightMarker()).toEqual({
      installPath: '/srv/pz',
      serverName: 'myserver',
      startedAt: 1000,
    })
  })

  it('returns null when nothing was ever written', () => {
    expect(readInstallInFlightMarker()).toBeNull()
  })

  it('clears the marker so a later read sees nothing', () => {
    writeInstallInFlightMarker({ installPath: '/srv/pz', serverName: 'myserver', startedAt: 1000 })
    clearInstallInFlightMarker()
    expect(readInstallInFlightMarker()).toBeNull()
  })

  it('treats malformed JSON as absent rather than throwing', () => {
    localStorage.setItem(INSTALL_INFLIGHT_KEY, '{not valid json')
    expect(readInstallInFlightMarker()).toBeNull()
  })

  it('treats a marker missing a required field as absent -- a shape from an older/newer build must not be trusted blindly', () => {
    localStorage.setItem(INSTALL_INFLIGHT_KEY, JSON.stringify({ installPath: '/srv/pz' }))
    expect(readInstallInFlightMarker()).toBeNull()
  })

  it('treats a non-object value (e.g. a bare string or number) as absent', () => {
    localStorage.setItem(INSTALL_INFLIGHT_KEY, JSON.stringify('just a string'))
    expect(readInstallInFlightMarker()).toBeNull()
    localStorage.setItem(INSTALL_INFLIGHT_KEY, JSON.stringify(42))
    expect(readInstallInFlightMarker()).toBeNull()
  })
})
