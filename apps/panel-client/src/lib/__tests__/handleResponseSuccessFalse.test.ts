import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverApi } from '../api'

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
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'Server is not running' }),
    )

    await expect(serverApi.getPanelInfo()).rejects.toThrow(
      'Server is not running',
    )
  })

  it('does NOT throw for a genuine success (success: true)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ success: true, response: 'Unbanned griefer123' }),
    )

    await expect(serverApi.getPanelInfo()).resolves.toMatchObject({
      success: true,
    })
  })

  it('does NOT throw when the response has no `success` field at all — most endpoints never had one', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ servers: [] }))

    await expect(serverApi.getPanelInfo()).resolves.toEqual({
      servers: [],
    })
  })
})
