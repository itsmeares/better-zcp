import { describe, expect, it, vi } from 'vitest'
import { invokeServerFunction } from './serverFunctionRpc'

describe('invokeServerFunction', () => {
  it('passes the RPC payload to the server function and returns its result', async () => {
    const serverFunction = {
      __executeServer: vi.fn(async () => ({ result: { ok: true } })),
    }
    const options = { data: { id: 'server-1' }, context: { requestId: 'test' } }

    await expect(
      invokeServerFunction(serverFunction, 'getServer', options),
    ).resolves.toEqual({ ok: true })
    expect(serverFunction.__executeServer).toHaveBeenCalledWith(options)
  })

  it('rethrows a server function error without replacing it', async () => {
    const error = new Error('permission denied')
    const serverFunction = {
      __executeServer: vi.fn(async () => ({ error })),
    }

    await expect(
      invokeServerFunction(serverFunction, 'getServer', {}),
    ).rejects.toBe(error)
  })

  it('fails clearly when a server function is not available', async () => {
    await expect(invokeServerFunction({}, 'getServer', {})).rejects.toThrow(
      'Server function getServer is not available',
    )
  })
})
