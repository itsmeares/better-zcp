import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Debug from '../Debug'
import { apiFetch } from '@/lib/api'

// 2026-08-30 visual sweep (fix-backups-dead-spinner-and-debug-environment):
// every field on Debug > Environment (Node.js, Platform, Uptime, Memory,
// Database, Logs folder) fell back to a bare "-" whenever fetchSystemInfo()
// didn't produce usable data -- and, unlike this page's Health tab, there
// was no error state at all to distinguish "still loading" from "this
// genuinely failed and will never resolve". These are facts about the
// panel's own Node process, not the configured game server, so an
// indefinite "-" here is never explained by "waiting on server setup" the
// way it legitimately can be elsewhere in the app.

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

const validSystemInfo = {
  nodeVersion: 'v22.9.0',
  platform: 'linux',
  uptime: 3661,
  memoryUsage: { heapUsed: 50 * 1024 * 1024, heapTotal: 100 * 1024 * 1024 },
  dbPath: '.../data/db.json',
  logsPath: '.../data/logs',
  dataDir: '.../data',
  pathsConfigurable: true,
}

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

async function openEnvironmentTab() {
  // Radix's TabsTrigger switches on mousedown, not click (see
  // @radix-ui/react-tabs) -- fireEvent.click alone never flips the tab
  // (established pattern, e.g. Console.test.tsx's openRconTab).
  const tab = await screen.findByRole('tab', { name: /environment/i })
  fireEvent.mouseDown(tab, { button: 0 })
}

describe('Debug > Environment: distinguishes still-loading from confirmed-unavailable', () => {
  it('shows the real values once /debug/system succeeds', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/system')) return jsonResponse(validSystemInfo)
      return jsonResponse({})
    })

    renderDebug()
    await openEnvironmentTab()

    expect(await screen.findByText('v22.9.0')).toBeInTheDocument()
    expect(screen.getByText('linux')).toBeInTheDocument()
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
  })

  it('labels every field "Unavailable" (not a bare "-") once the request fails, instead of hanging forever unlabeled', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/system')) return jsonResponse({ error: 'nope' }, false, 500)
      return jsonResponse({})
    })

    renderDebug()
    await openEnvironmentTab()

    // Six fields on this tab read from systemInfo: Node.js, Platform,
    // Uptime, Memory (+ "of ... heap"), Database, Logs folder.
    await waitFor(() => {
      expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(6)
    })
  })

  it('labels every field "Unavailable" when the response is 200 but missing memoryUsage (the field the client uses to validate the payload)', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/system')) return jsonResponse({ nodeVersion: 'v22.9.0' })
      return jsonResponse({})
    })

    renderDebug()
    await openEnvironmentTab()

    await waitFor(() => {
      expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(6)
    })
  })
})
