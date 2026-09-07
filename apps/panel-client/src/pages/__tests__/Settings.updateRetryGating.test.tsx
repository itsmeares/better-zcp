import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from '@/lib/routerCompat'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi, panelUpdateApi } from '@/lib/api'


vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    panelUpdateApi: {
      ...actual.panelUpdateApi,
      getStatus: vi.fn(),
      preflight: vi.fn(),
    },
  }
})

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)

function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler)
    }),
    emit: vi.fn(),
  }
  return {
    socket: socket as unknown as Socket,
    trigger: (event: string, data?: unknown) => {
      listeners.get(event)?.forEach(h => h(data))
    },
  }
}

function renderSettings(socket: Socket) {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=updates']}>
      <SocketContext.Provider value={socket}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings.tsx: Restart-and-Apply gating on a failed, unretryable panel update (GH#141)', () => {
  it('disables Restart once canRetryApply:false arrives, even though it was enabled a moment ago', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
    })

    getStatus.mockResolvedValueOnce({
      currentVersion: '1.2.14', updateAvailable: true, latestVersion: '1.2.15',
      releaseUrl: null, releaseNotes: null, publishedAt: null,
      isChecking: false, isDownloading: false, downloadProgress: 0,
      lastCheck: null, lastError: null, updateMode: 'direct',
      stagedUpdate: { version: '1.2.15', path: 'C:/panel/update.new.exe' },
      lastApplyResult: null,
    })

    const { socket, trigger } = createFakeSocket()
    renderSettings(socket)

    const restartButton = await screen.findByRole('button', { name: 'Restart and Apply Update' })
    expect(restartButton).toBeEnabled()

    getStatus.mockResolvedValueOnce({
      currentVersion: '1.2.14', updateAvailable: true, latestVersion: '1.2.15',
      releaseUrl: null, releaseNotes: null, publishedAt: null,
      isChecking: false, isDownloading: false, downloadProgress: 0,
      lastCheck: null, lastError: null, updateMode: 'direct',
      stagedUpdate: null,
      lastApplyResult: {
        status: 'failed', pendingVersion: '1.2.15', currentVersion: '1.2.14',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: null, likelyCause: 'av_quarantine', canRetryApply: false,
        panelFolder: 'C:/panel',
      },
    })

    trigger('panel:updateApplyFailed', { pendingVersion: '1.2.15', helperLog: null })

    await screen.findByText(/re-download the update before retrying/i)
    expect(restartButton).toBeDisabled()
  })
})
