import { describe, it, expect } from 'vitest'
import { emptyServersDescKey, pingFailDescKey } from '../ServerFinder'


describe('emptyServersDescKey: three different empty-list causes, three different messages', () => {
  it('no API key overrides everything else', () => {
    expect(emptyServersDescKey(false, 'no-servers-listed')).toBe('emptyState.noApiKeyDesc')
    expect(emptyServersDescKey(false, undefined)).toBe('emptyState.noApiKeyDesc')
  })

  it("'master-unreachable' -- the panel itself couldn't ask", () => {
    expect(emptyServersDescKey(true, 'master-unreachable')).toBe('emptyState.noServersDescUnreachable')
  })

  it("'no-servers-responded' -- asked, got a list, nothing answered in time", () => {
    expect(emptyServersDescKey(true, 'no-servers-responded')).toBe('emptyState.noServersDescNoneResponded')
  })

  it("'no-servers-listed' -- asked, genuinely zero servers listed", () => {
    expect(emptyServersDescKey(true, 'no-servers-listed')).toBe('emptyState.noServersDescGenuinelyEmpty')
  })

  it('falls back to the generic message for the steam_api path (emptyReason undefined)', () => {
    expect(emptyServersDescKey(true, undefined)).toBe('emptyState.noServersDesc')
  })
})

describe('pingFailDescKey: "answered but unreadable" vs "never answered" are different next steps', () => {
  it("'unparseable-response' -- the server IS running and reachable", () => {
    expect(pingFailDescKey('unparseable-response')).toBe('serverItem.pingFailUnparseable')
  })

  it('timeout, socket-error, and a client-side request failure all read as "never answered"', () => {
    expect(pingFailDescKey('timeout')).toBe('serverItem.pingFailUnreachable')
    expect(pingFailDescKey('socket-error')).toBe('serverItem.pingFailUnreachable')
    expect(pingFailDescKey('request-failed')).toBe('serverItem.pingFailUnreachable')
    expect(pingFailDescKey(undefined)).toBe('serverItem.pingFailUnreachable')
  })
})
