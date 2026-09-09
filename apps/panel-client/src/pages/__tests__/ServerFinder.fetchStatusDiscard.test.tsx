import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from '@/test/router'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerFinder from '../ServerFinder'

const getServerFinderMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/serverFinder', () => ({
  getServerFinder: getServerFinderMock,
  pingServerFinder: vi.fn(),
}))

beforeEach(() => {
  getServerFinderMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
  void i18n.changeLanguage('en')
})

function renderServerFinder() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter>
          <ServerFinder />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('ServerFinder.tsx fetchServers: preserves status so a real failure gets a real message', () => {
  it('shows the generic-500 wrapper around the real server detail, not the bare detail alone', async () => {
    getServerFinderMock.mockRejectedValueOnce(
      new ApiError('Steam API request failed', {
        status: 500,
        code: 'HTTP_500',
      }),
    )

    renderServerFinder()

    expect(await screen.findByText(/Steam API request failed/)).toBeInTheDocument()
    expect(await screen.findByText(/wasn't expected/)).toBeInTheDocument()
  })

  it('translates once status/code survive the fetch, same as every other converted site', async () => {
    void i18n.changeLanguage('fr')
    getServerFinderMock.mockRejectedValueOnce(
      new ApiError('Some unexpected failure', {
        status: 503,
        code: 'HTTP_503',
      }),
    )

    renderServerFinder()

    expect(await screen.findByText(/n'était pas attendu/)).toBeInTheDocument()
  })

  it('shows a real status-based message instead of a raw JSON-parse error when the body is not JSON', async () => {
    getServerFinderMock.mockRejectedValueOnce(
      new ApiError("HTTP 502", {
        status: 502,
        code: 'HTTP_502',
      }),
    )

    renderServerFinder()

    expect(await screen.findByText(/HTTP 502/)).toBeInTheDocument()
    expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument()
  })
})
