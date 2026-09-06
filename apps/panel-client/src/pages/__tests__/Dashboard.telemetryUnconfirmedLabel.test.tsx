import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// impeccable-2026-08-31: performanceHistory (debugApi.getPerformanceHistory)
// is the server's own persisted host-metrics log -- independent of the
// online/hostUnknown check the verdict headline above it uses. Recent
// samples can survive in that log even while the verdict can't confirm the
// server right now, so the telemetry header used to say "LAST 3 MIN · LIVE"
// with real numbers directly under a "Server status unknown" headline --
// two widgets on the same page disagreeing about whether we're connected.
// Confirmed on dashboard__desktop__light.png (Phase 1 critique). Fix: when
// the verdict itself can't confirm the server (!online), swap the "live"
// wording for an honest "unconfirmed" one -- same recency info, no claim
// the verdict headline is already contradicting.

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

// Two samples 90s apart -- recent enough to land in the "last Ns" branch,
// which is the one that used to say "live" unconditionally.
const recentHistory = [
  { timestamp: '2026-08-31T09:58:00.000Z', playerCount: 0, cpuUsage: 20, memoryUsed: 100, hostMemUsed: 1, hostMemTotal: 2, hostDiskUsed: 1, hostDiskTotal: 2 },
  { timestamp: '2026-08-31T09:59:30.000Z', playerCount: 0, cpuUsage: 22, memoryUsed: 100, hostMemUsed: 1, hostMemTotal: 2, hostDiskUsed: 1, hostDiskTotal: 2 },
]

async function setUpCommon(server: ServerInstance) {
  getResolvedActive.mockResolvedValue({ server })
  getStatus.mockResolvedValue({
    running: false, startTime: null, uptime: 0, serverPath: '',
    serverPathConfigured: false, rcon: { host: server.rconHost, port: server.rconPort, connected: false },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
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

describe('Dashboard.tsx: telemetry recency label vs. the verdict\'s own confirmed-connection check', () => {
  it('says "unconfirmed", not "live", when the verdict cannot confirm the server (hostUnknown) but recent host samples still exist', async () => {
    const remote = makeServer({ isRemote: true })
    await setUpCommon(remote)
    getComposedStatus.mockResolvedValue({
      provider: 'remote', selected: true,
      host: { status: 'unknown', label: 'Unknown', detail: null },
      server: { status: 'disconnected', label: 'Disconnected', detail: null },
      bridge: { status: 'inactive', label: 'Inactive', detail: null },
      summary: 'unknown',
    })
    getPerformanceHistory.mockResolvedValue({ history: recentHistory })

    renderDashboard()

    await screen.findByText('servertest')
    expect(await screen.findByText(/unconfirmed/i)).toBeInTheDocument()
    expect(screen.queryByText(/·\s*live/i)).not.toBeInTheDocument()
  })

  it('still says "live" for the same recent samples when the verdict DOES confirm the server is online (regression guard)', async () => {
    const remote = makeServer({ isRemote: true })
    await setUpCommon(remote)
    getComposedStatus.mockResolvedValue({
      provider: 'remote', selected: true,
      host: { status: 'running', label: 'Running', detail: null },
      server: { status: 'connected', label: 'Connected', detail: null },
      bridge: { status: 'active', label: 'Active', detail: null },
      summary: 'running',
    })
    getPerformanceHistory.mockResolvedValue({ history: recentHistory })

    renderDashboard()

    await screen.findByText('servertest')
    expect(await screen.findByText(/·\s*live/i)).toBeInTheDocument()
    expect(screen.queryByText(/unconfirmed/i)).not.toBeInTheDocument()
  })
})
