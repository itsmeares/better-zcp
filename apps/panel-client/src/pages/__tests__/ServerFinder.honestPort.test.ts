import { describe, it, expect } from 'vitest'
import { pingKey, displayPort, displayAddress } from '../ServerFinder'


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
    const serverA = { ip: '203.0.113.10', port: null }
    const serverB = { ip: '203.0.113.10', port: null }
    expect(pingKey(serverA)).toBeNull()
    expect(pingKey(serverB)).toBeNull()
  })
})
