import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { getHealthHeadline } from '../Debug'

const t = ((key: string) => key) as unknown as TFunction

function health(overrides: {
  status?: 'ok' | 'error'
  rconConnected?: boolean
  serverRunning?: boolean
} = {}) {
  return {
    status: overrides.status ?? 'ok',
    timestamp: '2026-08-31T12:00:00.000Z',
    services: {
      rcon: { connected: overrides.rconConnected ?? true, host: 'localhost:27015' },
      server: { running: overrides.serverRunning ?? true },
      modChecker: { running: true, interval: 60000 },
    },
    memory: { heapUsed: 1, heapTotal: 1, rss: 1, external: 0 },
    uptime: 1,
  }
}

describe('getHealthHeadline', () => {
  it('is "checking" while healthStatus has not loaded yet', () => {
    expect(getHealthHeadline(null, t)).toEqual({ tone: 'checking', title: 'healthTab.checking' })
  })

  it('is "healthy" when status is ok and both RCON and the game server are up', () => {
    expect(getHealthHeadline(health(), t)).toEqual({ tone: 'healthy', title: 'healthTab.healthy' })
  })

  it('is "issues" when status is not ok, REGARDLESS of service state -- status keeps meaning "the collection itself failed"', () => {
    expect(getHealthHeadline(health({ status: 'error', rconConnected: true, serverRunning: true }), t)).toEqual({
      tone: 'issues',
      title: 'healthTab.issuesDetected',
    })
  })

  it('never says "healthy" while RCON is disconnected, even though status is ok -- names RCON specifically', () => {
    const result = getHealthHeadline(health({ rconConnected: false }), t)
    expect(result.tone).not.toBe('healthy')
    expect(result).toEqual({ tone: 'servicesDown', title: 'healthTab.rconOffline' })
  })

  it('never says "healthy" while the game server is stopped, even though status is ok -- names the game server specifically', () => {
    const result = getHealthHeadline(health({ serverRunning: false }), t)
    expect(result.tone).not.toBe('healthy')
    expect(result).toEqual({ tone: 'servicesDown', title: 'healthTab.gameServerOffline' })
  })

  it('names both when RCON and the game server are both down', () => {
    const result = getHealthHeadline(health({ rconConnected: false, serverRunning: false }), t)
    expect(result).toEqual({ tone: 'servicesDown', title: 'healthTab.rconAndServerOffline' })
  })
})
