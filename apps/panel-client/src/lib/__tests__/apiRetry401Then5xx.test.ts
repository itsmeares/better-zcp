import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../api'
import { clearAccessToken, setAccessToken } from '../authToken'


function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fetchWithRetry: TOKEN_EXPIRED allows exactly one authentication replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setAccessToken('expired-token')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clearAccessToken()
  })

  it('returns a transient 5xx from the post-refresh replay without sending again', async () => {
    let targetCallCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'fresh-token' })
      }
      targetCallCount++
      if (targetCallCount === 1) return jsonResponse(401, { code: 'TOKEN_EXPIRED', error: 'expired' })
      if (targetCallCount === 2) return jsonResponse(503, { error: 'temporarily unavailable' })
      return jsonResponse(200, { ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    const promise = apiFetch('/some/protected/endpoint')
    await vi.advanceTimersByTimeAsync(3000)
    const response = await promise

    expect(response.status).toBe(503)
    expect(targetCallCount).toBe(2)
  })

  it('still returns a non-retryable status from the post-refresh retry immediately (unchanged behavior)', async () => {
    let targetCallCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'fresh-token' })
      }
      targetCallCount++
      if (targetCallCount === 1) return jsonResponse(401, { code: 'TOKEN_EXPIRED', error: 'expired' })
      return jsonResponse(403, { error: 'forbidden' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const promise = apiFetch('/some/protected/endpoint')
    await vi.advanceTimersByTimeAsync(3000)
    const response = await promise

    expect(response.status).toBe(403)
    expect(targetCallCount).toBe(2)
  })

  it('still force-reloads when the refreshed token itself still 401s (unchanged behavior)', async () => {
    const originalLocation = window.location
    const reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    })

    let targetCallCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'fresh-token' })
      }
      targetCallCount++
      return jsonResponse(401, { code: 'TOKEN_EXPIRED', error: 'expired' })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const promise = apiFetch('/some/protected/endpoint')
      await vi.advanceTimersByTimeAsync(3000)
      const response = await promise

      expect(response.status).toBe(401)
      expect(targetCallCount).toBe(2)
      expect(reloadSpy).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })
})
