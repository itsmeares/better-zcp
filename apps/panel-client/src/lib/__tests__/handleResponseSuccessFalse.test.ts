import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playersApi } from '../api'

// Regression coverage for the "false success toast" bug: several RCON/bridge
// actions resolve with HTTP 200 and `{ success: false, error: '...' }` when
// the underlying game server is offline or unreachable — not a thrown
// error. The shared handleResponse() used to hand that straight back to the
// caller as a normal resolved value, so a generic `await fn(); toast(Success)`
// call site (Players.tsx's handleAction, among ~40 others) had no way to
// know the action had failed. See the success-toast audit for the full list.
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('handleResponse: HTTP 200 with success:false', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws with the SERVER-SUPPLIED message, not a generic one — the message must survive the fix', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: false, error: 'Server is not running' }),
    )

    await expect(playersApi.unban('griefer123')).rejects.toThrow('Server is not running')
  })

  it('does NOT throw for a genuine success (success: true)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: true, response: 'Unbanned griefer123' }),
    )

    await expect(playersApi.unban('griefer123')).resolves.toMatchObject({ success: true })
  })

  it('does NOT throw when the response has no `success` field at all — most endpoints never had one', async () => {
    // e.g. GET /api/servers returns { servers: [...] } — no success key,
    // never meant to be judged by this check. Strict equality is what
    // protects this: only a LITERAL `false` trips it.
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ servers: [] }))

    await expect(playersApi.unban('griefer123')).resolves.toEqual({ servers: [] })
  })
})
