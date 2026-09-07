import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from '@/test/router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi, panelUpdateApi, systemApi } from '@/lib/api'
import { resetRuntimeInfoForTests } from '@/hooks/useRuntimeInfo'


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
    systemApi: { ...actual.systemApi, getRuntime: vi.fn() },
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
const getRuntime = vi.mocked(systemApi.getRuntime)

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

function fakeSocket(): Socket {
  return {
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as Socket
}

function statusWithApplyResult(
  lastApplyResult: Record<string, unknown>,
) {
  return {
    currentVersion: '1.2.14', updateAvailable: true, latestVersion: '1.2.15',
    releaseUrl: null, releaseNotes: null, publishedAt: null,
    isChecking: false, isDownloading: false, downloadProgress: 0,
    lastCheck: null, lastError: null, updateMode: 'direct',
    stagedUpdate: null,
    lastApplyResult,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetRuntimeInfoForTests()
})

describe('Settings.tsx: rollback_failed hint carries the retry-risk distinction honestly', () => {
  it('rollbackRetryLikely:true shows the retry warning and all three files to delete', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
    })
    getRuntime.mockResolvedValue({
      platform: 'win32', family: 'windows', pathSeparator: '\\',
      temporaryDirectory: 'C:/tmp', serviceManager: 'none',
      restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
    })
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.15', currentVersion: '1.2.14',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: null, likelyCause: 'rollback_failed', rollbackRetryLikely: true,
        canRetryApply: false, panelFolder: 'C:/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/likely to retry this exact update again/i)
    expect(screen.getByText(/\.update-pending/)).toBeInTheDocument()
    expect(screen.getByText(/\.update-applying/)).toBeInTheDocument()
    expect(screen.getByText(/update-bundle\.json/)).toBeInTheDocument()
    expect(screen.queryByText(/rolled back successfully/i)).not.toBeInTheDocument()
  })

  it('rollbackRetryLikely:false shows the cosmetic message and only the one leftover file -- must not claim a retry', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
    })
    getRuntime.mockResolvedValue({
      platform: 'win32', family: 'windows', pathSeparator: '\\',
      temporaryDirectory: 'C:/tmp', serviceManager: 'none',
      restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
    })
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.15', currentVersion: '1.2.14',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: null, likelyCause: 'rollback_failed', rollbackRetryLikely: false,
        canRetryApply: false, panelFolder: 'C:/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/rolled back successfully/i)
    expect(screen.queryByText(/likely to retry this exact update again/i)).not.toBeInTheDocument()
    expect(screen.getByText(/^update-bundle\.json$/)).toBeInTheDocument()
    expect(screen.queryByText(/\.update-pending/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\.update-applying/)).not.toBeInTheDocument()
  })

  it('on a non-Windows runtime, the rollback_failed block does not render at all (Supervisor v2 is Windows-only)', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'linux', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: '/tmp', applyLogPath: '/tmp/log.txt' },
    })
    getRuntime.mockResolvedValue({
      platform: 'linux', family: 'posix', pathSeparator: '/',
      temporaryDirectory: '/tmp', serviceManager: 'systemd',
      restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
    })
    getStatus.mockResolvedValue(
      statusWithApplyResult({
        status: 'failed', pendingVersion: '1.2.15', currentVersion: '1.2.14',
        at: new Date().toISOString(), stagedStillPresent: false,
        helperLog: null, likelyCause: 'rollback_failed', rollbackRetryLikely: true,
        canRetryApply: false, panelFolder: '/opt/panel',
      }),
    )

    renderSettings(fakeSocket())

    await screen.findByText(/still running v1\.2\.14/i)
    expect(screen.queryByText(/likely to retry this exact update again/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/rolled back successfully/i)).not.toBeInTheDocument()
  })
})
