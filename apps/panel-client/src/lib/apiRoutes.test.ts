import { afterEach, expect, it, vi } from 'vite-plus/test'
import { backupApi, modsApi, serversApi } from './api'
import { apiUrl } from './serverSelection'

afterEach(() => vi.unstubAllGlobals())

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
