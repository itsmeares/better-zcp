import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerFinder from '../ServerFinder'

// regression: fetchServers() called the raw apiFetch() primitive
// (which, unlike lib/api's xApi.method() calls, never runs handleResponse())
// and threw a plain Error on failure -- discarding response.status entirely
// before getUserErrorMessage() could ever translate it. Same shape as the
// AuthContext.tsx/FileDiffViewer.tsx/Debug.tsx/Login.tsx sites fixed earlier
// (068a896, 564f201): GET /server-finder's only failure mode is an uncoded
// 500 (apps/panel-server/routes/serverFinder.js), so this was a strict prerequisite for
// the generic-500 wrapper to ever reach this route at all, not just polish.

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  void i18n.changeLanguage('en')
})

function renderServerFinder() {
  return render(
    <TooltipProvider>
      <MemoryRouter>
        <ServerFinder />
      </MemoryRouter>
    </TooltipProvider>,
  )
}

describe('ServerFinder.tsx fetchServers: preserves status so a real failure gets a real message', () => {
  // Discriminating on the wrapper SUFFIX, not just the raw detail text: the
  // pre-fix plain Error's .message was already exactly the server's `error`
  // string, so asserting on that text alone would pass whether or not the
  // fix is in place. wrapUncodedServerError() only appends this suffix when
  // a real ApiError with status >= 500 reaches getUserErrorMessage() -- a
  // plain Error never gets it, at any status.
  it('shows the generic-500 wrapper around the real server detail, not the bare detail alone', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'Steam API request failed' }),
    } as Response)

    renderServerFinder()

    expect(await screen.findByText(/Steam API request failed/)).toBeInTheDocument()
    expect(await screen.findByText(/wasn't expected/)).toBeInTheDocument()
  })

  it('translates once status/code survive the fetch, same as every other converted site', async () => {
    void i18n.changeLanguage('fr')
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: 'Some unexpected failure' }),
    } as Response)

    renderServerFinder()

    expect(await screen.findByText(/n'était pas attendu/)).toBeInTheDocument()
  })

  // Discriminating case for the OTHER half of the fix (checking response.ok,
  // not just data.success): a non-JSON error body -- e.g. a proxy's HTML
  // error page in front of a 502 -- used to make response.json() throw a
  // raw SyntaxError straight into the catch block, showing the operator a
  // "Unexpected token '<'..." parser message instead of anything about the
  // actual failure. The fix's `.json().catch(() => null)` plus checking
  // response.ok directly (not just data.success, which a null data can
  // never satisfy) means a real HTTP-status-based message reaches the
  // operator instead.
  it('shows a real status-based message instead of a raw JSON-parse error when the body is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError("Unexpected token '<'") },
    } as unknown as Response)

    renderServerFinder()

    expect(await screen.findByText(/HTTP 502/)).toBeInTheDocument()
    expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument()
  })
})
