import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Debug from '../Debug'
import { apiFetch } from '@/lib/api'

// 2026-08-30 visual sweep: Debug > Health's status headline used
// `healthStatus?.status === "ok"` to choose between "Healthy" and "Issues
// Detected" -- but that expression is false both when the check genuinely
// found issues AND when fetchHealthStatus() simply hasn't resolved yet
// (healthStatus is still null). Every page load hit a real window, however
// brief, where the headline read "Issues Detected" next to the subtitle's
// own "Never checked" -- a page contradicting itself in its own strings,
// same disease as the Environment tab's bare "-" fixed alongside it in
// a83c425a.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, apiFetch: vi.fn() }
})

const mockedApiFetch = vi.mocked(apiFetch)

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

const okHealth = {
  status: 'ok',
  timestamp: '2026-08-30T12:00:00.000Z',
  services: {
    rcon: { connected: true, host: 'localhost:27015' },
    server: { running: true },
    modChecker: { running: true, interval: 60000 },
  },
  memory: { heapUsed: 50 * 1024 * 1024, heapTotal: 100 * 1024 * 1024, rss: 120 * 1024 * 1024, external: 0 },
  uptime: 3661,
}

const errorHealth = { ...okHealth, status: 'error' }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDebug() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Debug />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function openHealthTab() {
  // Radix's TabsTrigger switches on mousedown, not click (see
  // @radix-ui/react-tabs) -- fireEvent.click alone never flips the tab
  // (established pattern, e.g. Console.test.tsx's openRconTab).
  const tab = await screen.findByRole('tab', { name: /health/i })
  fireEvent.mouseDown(tab, { button: 0 })
}

describe('Debug > Health: distinguishes not-yet-checked from a real "issues detected" verdict', () => {
  it('shows "Checking..." (not "Issues Detected") while /debug/health is still in flight', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/health')) return pending
      return jsonResponse({})
    })

    renderDebug()
    await openHealthTab()

    expect(await screen.findByText('Checking...')).toBeInTheDocument()
    expect(screen.queryByText('Issues Detected')).not.toBeInTheDocument()
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument()

    resolveFetch(jsonResponse(okHealth))
    await waitFor(() => expect(screen.getByText('Healthy')).toBeInTheDocument())
  })

  it('shows "Healthy" once the check resolves with status "ok"', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/health')) return jsonResponse(okHealth)
      return jsonResponse({})
    })

    renderDebug()
    await openHealthTab()

    expect(await screen.findByText('Healthy')).toBeInTheDocument()
    expect(screen.queryByText('Issues Detected')).not.toBeInTheDocument()
    expect(screen.queryByText('Checking...')).not.toBeInTheDocument()
  })

  it('shows "Issues Detected" once the check genuinely resolves with a non-"ok" status', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/health')) return jsonResponse(errorHealth)
      return jsonResponse({})
    })

    renderDebug()
    await openHealthTab()

    expect(await screen.findByText('Issues Detected')).toBeInTheDocument()
    expect(screen.queryByText('Checking...')).not.toBeInTheDocument()
  })
})
