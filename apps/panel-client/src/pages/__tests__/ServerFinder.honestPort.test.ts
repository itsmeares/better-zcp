import { describe, it, expect } from 'vitest'
import { pingKey, displayPort, displayAddress } from '../ServerFinder'

// The server no longer fabricates a guessed port (16261) when it can't
// parse one -- it now sends port: null (apps/panel-server/routes/serverFinder.js
// mapSteamServer()). If the UI then printed the literal string "null"
// where an address goes, or wrote pings under an "<ip>:null" key shared by
// every portless server on that IP, the same fabrication bug would just be
// relocated from the data layer to the presentation layer. These three
// helpers are what keep the client honest about a genuinely unknown port.

describe('displayAddress / displayPort: never render the literal "null"', () => {
  it('shows ip:port when the query port is known', () => {
    expect(displayAddress({ ip: '203.0.113.10', port: 16261, gamePort: undefined })).toBe(
      '203.0.113.10:16261',
    )
  })

  it('prefers gamePort over port when both are known', () => {
    expect(displayAddress({ ip: '203.0.113.10', port: 16261, gamePort: 16262 })).toBe(
      '203.0.113.10:16262',
    )
  })

  it('falls back to port when gamePort is absent', () => {
    expect(displayPort({ port: 16261, gamePort: undefined })).toBe(16261)
  })

  it('shows the bare IP -- never "<ip>:null" -- when neither port is known', () => {
    const address = displayAddress({ ip: '203.0.113.10', port: null, gamePort: undefined })
    expect(address).toBe('203.0.113.10')
    expect(address).not.toContain('null')
  })

  it('treats gamePort: 0 as not-known rather than a real port', () => {
    // 0 is not a valid game server port; falling through to port (or null)
    // here matches the server's own parseQueryPort range check (1-65535).
    expect(displayPort({ port: null, gamePort: 0 })).toBeNull()
  })
})

describe('pingKey: no cache entry is ever written for a portless server', () => {
  it('derives a key when the query port is known', () => {
    expect(pingKey({ ip: '203.0.113.10', port: 16261 })).toBe('203.0.113.10:16261')
  })

  it('returns null when the query port is unknown, never "<ip>:null"', () => {
    expect(pingKey({ ip: '203.0.113.10', port: null })).toBeNull()
  })

  it('two distinct portless servers on the same IP both key to null, never to a shared string', () => {
    // The collision this guards against: if pingKey ever fell back to
    // `${ip}:null`, two different portless servers on one IP would share
    // one serverPings entry and one pingingServers guard, so pinging one
    // would silently mark the other as pinged/pinged-result too. Returning
    // null for both means the caller never writes either into those maps
    // at all (see ServerFinder.tsx's ping button, which renders a
    // non-interactive "N/A" instead of a clickable ping for a null key).
    const serverA = { ip: '203.0.113.10', port: null }
    const serverB = { ip: '203.0.113.10', port: null }
    expect(pingKey(serverA)).toBeNull()
    expect(pingKey(serverB)).toBeNull()
  })
})
