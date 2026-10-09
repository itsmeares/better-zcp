import { describe, expect, it } from 'vite-plus/test'
import { getHealthHeadline } from '../diagnostics/healthHeadline'

function status(running: boolean | null, connected = true) {
  return {
    status: 'ok' as const,
    services: {
      rcon: { connected, host: 'localhost' },
      server: { running, scanFailed: running === null },
      modChecker: { running: true, interval: 60_000 },
    },
  }
}

describe('diagnostics health headline', () => {
  it('keeps an inconclusive server scan distinct from a stopped server', () => {
    expect(getHealthHeadline(status(null))).toEqual({ tone: 'unknown', title: 'Server status unknown' })
    expect(getHealthHeadline(status(false))).toEqual({ tone: 'servicesDown', title: 'Server stopped' })
  })

  it('reports a confirmed RCON outage while preserving unknown server state', () => {
    expect(getHealthHeadline(status(null, false))).toEqual({ tone: 'servicesDown', title: 'RCON disconnected, server status unknown' })
    expect(getHealthHeadline(status(false, false))).toEqual({ tone: 'servicesDown', title: 'RCON disconnected, server stopped' })
  })
})
