import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from '@/test/router'
import i18n from '@/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerFinder from '../ServerFinder'


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
