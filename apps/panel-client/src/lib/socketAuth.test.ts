import { beforeEach, describe, expect, it, vi } from 'vitest'

const tryRefreshToken = vi.fn()
vi.mock('./api', () => ({ tryRefreshToken: (...args: unknown[]) => tryRefreshToken(...args) }))

const { createSocketAuthProvider } = await import('./socketAuth')

function makeToken(expiresInSeconds: number): string {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payload = { exp: Math.floor(Date.now() / 1000) + expiresInSeconds }
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.sig`
}

describe('createSocketAuthProvider', () => {
  beforeEach(() => {
    tryRefreshToken.mockReset()
  })

  it('does not call tryRefreshToken and hands back the current token when it is still comfortably valid', async () => {
    const token = makeToken(15 * 60)
    const getToken = vi.fn(() => token)
    const callback = vi.fn()

    createSocketAuthProvider(getToken)(callback)
    await Promise.resolve()
    await Promise.resolve()

    expect(tryRefreshToken).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith({ token })
  })

  it('refreshes first when the token is expired, then hands back the refreshed token', async () => {
    const staleToken = makeToken(-60)
    const freshToken = makeToken(15 * 60)
    let currentToken = staleToken
    tryRefreshToken.mockImplementation(async () => {
      currentToken = freshToken
      return true
    })
    const getToken = vi.fn(() => currentToken)
    const callback = vi.fn()

    createSocketAuthProvider(getToken)(callback)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(tryRefreshToken).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ token: freshToken })
  })

  it('refreshes first when the token is within the near-expiry buffer', async () => {
    const nearExpiryToken = makeToken(30) // inside the 60s buffer
    tryRefreshToken.mockResolvedValue(true)
    const getToken = vi.fn(() => nearExpiryToken)
    const callback = vi.fn()

    createSocketAuthProvider(getToken)(callback)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(tryRefreshToken).toHaveBeenCalledTimes(1)
  })

  it('hands back an empty payload without ever calling refresh when there is no token at all', async () => {
    const getToken = vi.fn(() => null)
    const callback = vi.fn()

    createSocketAuthProvider(getToken)(callback)
    await Promise.resolve()
    await Promise.resolve()

    expect(tryRefreshToken).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith({})
  })

  it('still hands back an empty payload if refresh fails and leaves no token behind', async () => {
    const staleToken = makeToken(-60)
    let currentToken: string | null = staleToken
    tryRefreshToken.mockImplementation(async () => {
      currentToken = null // refresh failed -- token store cleared
      return false
    })
    const getToken = vi.fn(() => currentToken)
    const callback = vi.fn()

    createSocketAuthProvider(getToken)(callback)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(callback).toHaveBeenCalledWith({})
  })
})
