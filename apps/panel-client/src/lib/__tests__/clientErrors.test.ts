import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reportClientError, reportClientWarning } from '../client-errors'

describe('client-errors', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reportClientError sends POST to server', () => {
    reportClientError('Test error', new Error('boom'))
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/debug/client-errors',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.message).toBe('Test error')
    expect(body.error).toBe('boom')
  })

  it('reportClientWarning sends POST to server', () => {
    reportClientWarning('Test warning', 'detail')
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/debug/client-errors',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('does not throw when fetch fails', () => {
    fetchSpy.mockRejectedValue(new Error('network down'))
    expect(() => reportClientError('test')).not.toThrow()
  })

  it('truncates long messages', () => {
    const longMessage = 'x'.repeat(1000)
    reportClientError(longMessage)
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.message.length).toBe(500)
  })
})
