import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    handler:
      (handler: (args: { data: undefined; context: undefined }) => unknown) =>
      () =>
        handler({ data: undefined, context: undefined }),
  }),
}))

vi.mock('../serverAuth.server', () => ({
  getAuthStatus: {},
  getOidcStatus: {},
  getRecoveryStatus: {},
  getCurrentUser: {},
}))

import { getAuthStatusWithFallback } from '../serverAuth'

describe('auth status fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the public auth endpoint when the Start function is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ needsSetup: false, authEnabled: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getAuthStatusWithFallback()).resolves.toEqual({
      needsSetup: false,
      authEnabled: true,
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/status')
  })
})
