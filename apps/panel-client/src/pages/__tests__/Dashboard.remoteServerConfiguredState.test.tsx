import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// 2026-08-31 visual sweep: status.serverPathConfigured (server-side renamed
// from `configured` in the same follow-up) is `!!serverManager.serverPath`
// (apps/panel-server/services/serverManager.js) -- a LOCAL install-path signal.
// installPath is not required for remote servers (apps/panel-server/routes/servers.js's
// create validation requires only name/rconHost/rconPort/rconPassword for
// isRemote:true), so a fully-configured remote server can never set it. The
// verdict and the "Not configured" banner both used to read this field
// alone, so a properly-configured remote server -- named, addressed, REMOTE-
// badged in its own header two lines above -- was told it had "No server
// configured" in the same frame. Same family as Layout.tsx's servers-as-[]
// fix (3665aa20): a signal that structurally cannot represent one real case
// (remote) was trusted for all cases instead of scoped to what it describes.
// The client-side !activeServer?.isRemote guards stay after the rename --
// the field's VALUE was always correct for what it actually gates (can the
// local launch path run), only its old NAME over-promised "is this server
// configured" in general.

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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serverApi: { ...actual.serverApi, getStatus: vi.fn(), getPanelInfo: vi.fn(), getConsoleErrorCount: vi.fn() },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn(), getResolvedActive: vi.fn() },
    playersApi: { ...actual.playersApi, getPlayers: vi.fn(), getActivityLogs: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getZombieCount: vi.fn(),
      getWorldStats: vi.fn(),
    },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    debugApi: { ...actual.debugApi, getPerformanceHistory: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    schedulerApi: { ...actual.schedulerApi, getTasks: vi.fn(), getStatus: vi.fn() },
  }
})

const getStatus = vi.mocked(serverApi.getStatus)
const getPanelInfo = vi.mocked(serverApi.getPanelInfo)
const getConsoleErrorCount = vi.mocked(serverApi.getConsoleErrorCount)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getPlayers = vi.mocked(playersApi.getPlayers)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getBackupStatus = vi.mocked(backupApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const getPerformanceHistory = vi.mocked(debugApi.getPerformanceHistory)
const getPanelUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const getModsStatus = vi.mocked(modsApi.getStatus)
const getSchedulerTasks = vi.mocked(schedulerApi.getTasks)
const getSchedulerStatus = vi.mocked(schedulerApi.getStatus)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'servertest', serverName: 'servertest', installPath: '',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '192.168.1.50', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: true, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

async function setUpCommon(server: ServerInstance) {
  getResolvedActive.mockResolvedValue({ server })
  getStatus.mockResolvedValue({
    running: false, startTime: null, uptime: 0, serverPath: '',
    serverPathConfigured: false, rcon: { host: server.rconHost, port: server.rconPort, connected: false },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getBridgeStatus.mockResolvedValue({ configured: true, isRunning: true, modConnected: false, modStatus: null })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: false, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 1 })
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 })
  getSchedulerTasks.mockResolvedValue({ tasks: [] })
  getSchedulerStatus.mockResolvedValue({ nextRun: null })
  getPerformanceHistory.mockResolvedValue({ history: [] })
  getPanelUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Dashboard />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Dashboard.tsx: a remote server is never told it is unconfigured by the local installPath signal', () => {
  it('remote server, status.configured false: shows the server itself, not the "not configured" verdict or banner', async () => {
    const remote = makeServer({ isRemote: true })
    await setUpCommon(remote)

    renderDashboard()

    expect(await screen.findByText('servertest')).toBeInTheDocument()
    expect(screen.queryByText('No server configured')).not.toBeInTheDocument()
    expect(screen.queryByText('Not configured')).not.toBeInTheDocument()
  })

  it('local server, status.configured false: still shows "not configured" (regression guard -- this case is real)', async () => {
    const local = makeServer({ isRemote: false, installPath: 'C:/servers/ashenwood', serverName: 'Ashenwood', name: 'Ashenwood' })
    await setUpCommon(local)

    renderDashboard()

    await screen.findByText('Ashenwood')
    // getAllByText, not getByText: the verdict headline renders twice by
    // design (a visible span plus a sr-only duplicate for the icon-only
    // status dot -- see VerdictBand), so a single-match query throws
    // "multiple elements found" every time, which waitFor swallows and
    // retries into the ground until the (deliberately long, see
    // test-setup.ts) asyncUtilTimeout.
    await waitFor(() => expect(screen.getAllByText('No server configured').length).toBeGreaterThan(0))
    expect(screen.getByText('Not configured')).toBeInTheDocument()
  })

  it('remote server, offline, status.configured false: Live Activity\'s empty state reads "not running", not "not configured" (third consumer of the same signal, caught in review after the verdict/banner fix)', async () => {
    const remote = makeServer({ isRemote: true })
    await setUpCommon(remote)

    renderDashboard()

    await screen.findByText('servertest')
    expect(await screen.findByText('Start the server to begin tracking player activity.')).toBeInTheDocument()
    expect(screen.queryByText('Configure a server to start tracking activity.')).not.toBeInTheDocument()
  })

  it('local server, status.configured true: no "not configured" state at all (baseline)', async () => {
    const local = makeServer({ isRemote: false, installPath: 'C:/servers/ashenwood', serverName: 'Ashenwood', name: 'Ashenwood' })
    await setUpCommon(local)
    getStatus.mockResolvedValue({
      running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
      serverPathConfigured: true, rcon: { host: '', port: 0, connected: false },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    renderDashboard()

    await screen.findByText('Ashenwood')
    expect(screen.queryByText('No server configured')).not.toBeInTheDocument()
    expect(screen.queryByText('Not configured')).not.toBeInTheDocument()
  })
})
