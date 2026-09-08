import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  toast: toastSpy,
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

import { playersApi } from '../api'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('handleResponse: backupWarning', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    toastSpy.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('surfaces a warning toast when a response carries backupWarning', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          backupWarning:
            'Could not back up the previous version before saving: ENOSPC. Your change was saved, but there is no safety copy of what was there before.',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          backupWarning:
            'Could not back up the previous version before saving: ENOSPC. Your change was saved, but there is no safety copy of what was there before.',
        }),
      )

    await playersApi.unban('griefer123')

    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'warning',
        description: expect.stringContaining('ENOSPC'),
      }),
    )
  })

  it('does NOT fire when there is no backupWarning field -- the normal, successful case', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))

    await playersApi.unban('griefer123')

    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('does NOT fire for a non-string backupWarning -- defensive against a malformed response', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ success: true, backupWarning: null }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, backupWarning: null }),
      )

    await playersApi.unban('griefer123')

    expect(toastSpy).not.toHaveBeenCalled()
  })
})
