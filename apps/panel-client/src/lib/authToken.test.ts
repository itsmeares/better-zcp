import { afterEach, describe, expect, it, vi } from 'vitest'
import { startInstance } from '../start'
import { clearAccessToken, setAccessToken } from './authToken'

afterEach(() => {
  clearAccessToken()
})

describe('auth client middleware', () => {
  it('adds the current bearer token to server-function calls', async () => {
    setAccessToken('test-token')
    const middleware = (await startInstance.getOptions()).functionMiddleware![0] as any
    const next = vi.fn(async (options: unknown) => options)

    await middleware.options.client({ next })

    expect(next).toHaveBeenCalledWith({
      headers: { Authorization: 'Bearer test-token' },
    })
  })
})
