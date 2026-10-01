import { describe, expect, it } from 'vite-plus/test'
import { getHealthHeadline } from '../debugHealthHeadline'

function status(running: boolean | null, connected = true) {
  return {
    status: 'ok' as const,
    timestamp: '',
    services: {
      rcon: { connected, host: 'localhost' },
      server: { running, scanFailed: running === null },
      modChecker: { running: true, interval: 60_000 },
    },
    memory: { heapUsed: 0, heapTotal: 0, rss: 0, external: 0 },
    uptime: 0,
  }
}

describe('debug health headline', () => {
  it('keeps an inconclusive server scan distinct from a stopped server', () => {
    expect(getHealthHeadline(status(null))).toEqual({
      tone: 'unknown',
      title: 'Server Status Unknown',
    })
    expect(getHealthHeadline(status(false))).toEqual({
      tone: 'servicesDown',
      title: 'Game Server Stopped',
    })
  })

  it('reports a confirmed RCON outage while preserving unknown server state', () => {
    expect(getHealthHeadline(status(null, false))).toEqual({
      tone: 'servicesDown',
      title: 'RCON Disconnected · Server Status Unknown',
    })
  })
})
