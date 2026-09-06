import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupApi } from '../api'
import { clearAccessToken, setAccessToken } from '../authToken'

// uploadBackup uses a raw XMLHttpRequest (needs upload progress events,
// which fetch cannot report), so it does NOT get fetchWithRetry's automatic
// "refresh once on TOKEN_EXPIRED, then replay" behaviour for free. This
// tests the hand-rolled equivalent added 2026-08-31.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

class FakeXhr {
  static instances: FakeXhr[] = []
  status = 0
  responseText = ''
  upload = { onprogress: null as ((e: any) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  headers: Record<string, string> = {}
  method = ''
  url = ''
  sentBody: any = null

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: any) {
    this.sentBody = body
    FakeXhr.instances.push(this)
  }

  respond(status: number, body: unknown) {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.onload?.()
  }
}

describe('uploadBackup: TOKEN_EXPIRED triggers exactly one refresh-and-replay', () => {
  beforeEach(() => {
    FakeXhr.instances = []
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest)
    setAccessToken('expired-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearAccessToken()
  })

  it('refreshes and replays once when the first attempt 401s with TOKEN_EXPIRED', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toContain('/api/auth/refresh')
      return jsonResponse(200, { accessToken: 'fresh-token' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = new File(['zip-bytes'], 'save.zip')
    const uploadPromise = backupApi.uploadBackup(file)

    // Let the XHR get constructed and sent before responding to it.
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeXhr.instances).toHaveLength(1)
    expect(FakeXhr.instances[0].headers.Authorization).toBe('Bearer expired-token')
    FakeXhr.instances[0].respond(401, { code: 'TOKEN_EXPIRED', error: 'expired' })

    // Wait for the refresh fetch + second XHR to be issued.
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2))
    expect(FakeXhr.instances[1].headers.Authorization).toBe('Bearer fresh-token')
    FakeXhr.instances[1].respond(200, {
      success: true,
      name: 'save.zip',
      size: 9,
      message: 'uploaded',
    })

    const result = await uploadPromise
    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not attempt a refresh for a non-TOKEN_EXPIRED failure (unrelated 401 or 4xx)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const file = new File(['zip-bytes'], 'save.zip')
    const uploadPromise = backupApi.uploadBackup(file)
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeXhr.instances).toHaveLength(1)
    FakeXhr.instances[0].respond(413, { error: 'too large' })

    await expect(uploadPromise).rejects.toThrow('too large')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(FakeXhr.instances).toHaveLength(1)
  })
})
