import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupApi } from '../api'
import { clearAccessToken, setAccessToken } from '../authToken'


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
  aborted = false

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

  abort() {
    this.aborted = true
    this.onabort?.()
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
    vi.useRealTimers()
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

    await Promise.resolve()
    await Promise.resolve()
    expect(FakeXhr.instances).toHaveLength(1)
    expect(FakeXhr.instances[0].headers.Authorization).toBe('Bearer expired-token')
    FakeXhr.instances[0].respond(401, { code: 'TOKEN_EXPIRED', error: 'expired' })

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

  it('aborts and rejects when the upload makes no progress for three minutes', async () => {
    vi.useFakeTimers()
    const file = new File(['zip-bytes'], 'save.zip')
    const uploadPromise = backupApi.uploadBackup(file)

    await Promise.resolve()
    await Promise.resolve()
    expect(FakeXhr.instances).toHaveLength(1)
    const assertion = expect(uploadPromise).rejects.toThrow(/stalled/i)

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000)

    expect(FakeXhr.instances[0].aborted).toBe(true)
    await assertion
  })

  it('resets the stall clock on upload progress', async () => {
    vi.useFakeTimers()
    const file = new File(['zip-bytes'], 'save.zip')
    const uploadPromise = backupApi.uploadBackup(file)

    await Promise.resolve()
    await Promise.resolve()
    const xhr = FakeXhr.instances[0]

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 })
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(xhr.aborted).toBe(false)

    xhr.respond(200, { success: true, name: 'save.zip', size: 9, message: 'uploaded' })
    await expect(uploadPromise).resolves.toMatchObject({ success: true })
  })
})
