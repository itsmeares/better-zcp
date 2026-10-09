import { afterEach, expect, it, vi } from 'vite-plus/test'
import { apiFetch, backupApi, modsApi, serversApi } from './api'
import { setAccessToken } from './authToken'
import { apiUrl } from './serverSelection'

afterEach(() => {
  vi.unstubAllGlobals()
  setAccessToken(null)
})

it('sends Node API paths, query values, and request bodies', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    requests.push({
      url,
      method: options?.method || 'GET',
      body: options?.body ? JSON.parse(String(options.body)) : undefined,
    })
    return Response.json({ success: true, server: {} })
  }))

  await serversApi.getLifecycleTemplate('one/two', 'systemd')
  await serversApi.update('one/two', { name: 'Renamed' })
  await modsApi.removeIgnoredModPair('A', 'B')
  await backupApi.restoreBackup('archive.zip', { expectedServerId: 'server-a' })

  expect(requests).toEqual([
    {
      url: '/api/servers/one%2Ftwo/lifecycle-template?provider=systemd',
      method: 'GET',
      body: undefined,
    },
    { url: '/api/servers/one%2Ftwo', method: 'PUT', body: { name: 'Renamed' } },
    {
      url: '/api/mods/ignored-pairs',
      method: 'DELETE',
      body: { modIdA: 'A', modIdB: 'B' },
    },
    {
      url: '/api/backup/restore/archive.zip',
      method: 'POST',
      body: { expectedServerId: 'server-a' },
    },
  ])
})

it('scopes game integration calls to the selected server profile', () => {
  expect(apiUrl('/game-integration/status', 'server-a')).toBe(
    '/api/servers/server-a/game-integration/status',
  )
  expect(apiUrl('/game-integration/status', null)).toBe(
    '/api/game-integration/status',
  )
})

it('keeps profile scope, refreshed bearer auth, and abort through an SSE replay', async () => {
  const controller = new AbortController()
  const requests: Array<{ url: string; authorization: string | null }> = []
  let replaySignal: AbortSignal | null | undefined
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  setAccessToken('expired-token')
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const path = String(url)
    const authorization = new Headers(options?.headers).get('Authorization')
    if (path === '/api/auth/refresh') {
      setAccessToken('refreshed-token')
      return Response.json({ accessToken: 'refreshed-token' })
    }

    requests.push({ url: path, authorization })
    if (authorization === 'Bearer expired-token') {
      return Response.json({ code: 'TOKEN_EXPIRED' }, { status: 401 })
    }

    replaySignal = options?.signal
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        streamController = stream
        stream.enqueue(new TextEncoder().encode('event: init\ndata: {}\n\n'))
      },
    })
    replaySignal?.addEventListener('abort', () => {
      streamController?.error(
        replaySignal?.reason ?? new DOMException('Aborted', 'AbortError'),
      )
    })
    return new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }))

  const endpoint = apiUrl('/mods/conflicts/stream', 'server-a').slice(4)
  const response = await apiFetch(endpoint, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
    timeout: 0,
  })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: init')
  expect(replaySignal).toBe(controller.signal)
  expect(requests).toEqual([
    {
      url: '/api/servers/server-a/mods/conflicts/stream',
      authorization: 'Bearer expired-token',
    },
    {
      url: '/api/servers/server-a/mods/conflicts/stream',
      authorization: 'Bearer refreshed-token',
    },
  ])

  const pendingRead = reader.read()
  controller.abort()
  await expect(pendingRead).rejects.toMatchObject({ name: 'AbortError' })
})

it('times out reads but lets long writes such as a backup finish', async () => {
  const signals: Record<string, AbortSignal | null | undefined> = {}
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    signals[options?.method || 'GET'] = options?.signal
    return Response.json({ success: true })
  }))

  await backupApi.getStatus()
  await backupApi.createBackup()

  expect(signals.GET).toBeInstanceOf(AbortSignal)
  expect(signals.POST).toBeUndefined()
})
