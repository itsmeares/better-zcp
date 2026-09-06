import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// GH#137: a reporter running the panel in Docker with PZ on the host saw
// the "Console" work-item row change position in the list just from
// leaving the panel open through a Stop/Start/Restart cycle -- three
// screenshots showed three different row orders for the exact same
// underlying section list. Traced to Dashboard.tsx's sortedWorkItems:
// RCON disconnecting during a routine Stop/Restart flips the Console
// row's tone from 'good' to 'warning', and the severity sort (added in
// cac5cdc8 to pull a genuinely 'bad' row above several calm ones) also
// reordered on that 'warning' transition -- reshuffling the whole list
// for a state the operator caused themselves and already knows about.
//
// This proves the list's row order is stable across that exact
// transition (RCON connected -> disconnected, nothing else changing).
// It must fail before the fix (warning ranked above default) and pass
// after (warning collapsed into the same rank as default/good; only
// 'bad' reorders anything).

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
const getZombieCount = vi.mocked(panelBridgeApi.getZombieCount)
const getWorldStats = vi.mocked(panelBridgeApi.getWorldStats)
const getBackupStatus = vi.mocked(backupApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const getPerformanceHistory = vi.mocked(debugApi.getPerformanceHistory)
const getPanelUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const getModsStatus = vi.mocked(modsApi.getStatus)
const getSchedulerTasks = vi.mocked(schedulerApi.getTasks)
const getSchedulerStatus = vi.mocked(schedulerApi.getStatus)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

// Server is running throughout -- only RCON's own connected flag flips,
// exactly what happens mid-Stop/Restart while the process is still being
// torn down. Everything else (players, bridge, mods, schedule, errors,
// backups) stays identical between the two renders on purpose, so any
// observed reorder can only be explained by the Console row's tone.
async function setUpCommon(rconConnected: boolean) {
  const server = makeServer()
  getResolvedActive.mockResolvedValue({ server })
  getStatus.mockResolvedValue({
    running: true, startTime: new Date().toISOString(), uptime: 600, serverPath: 'C:/servers/ashenwood',
    serverPathConfigured: true, rcon: { host: '127.0.0.1', port: 27015, connected: rconConnected },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: true, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 8 })
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 108 })
  getSchedulerTasks.mockResolvedValue({ tasks: [{ id: 1 }] })
  getSchedulerStatus.mockResolvedValue({ nextRun: null })
  getPerformanceHistory.mockResolvedValue({ history: [] })
  getPanelUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  getBridgeStatus.mockResolvedValue({
    configured: true, isRunning: true, modConnected: true,
    modStatus: { alive: true, version: '1.7.50', serverName: 'Ashenwood', playerCount: 0 },
  })
  getZombieCount.mockResolvedValue({ success: true, data: { zombieCount: 0, note: '' } })
  getWorldStats.mockResolvedValue({ success: true, data: { serverName: 'Ashenwood', map: 'Muldraugh, KY', zombiesInCell: 0 } })
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

// Compare by destination (id/href), not full row text -- the row's own
// live state text (e.g. "rcon ready" vs "rcon offline") is EXPECTED to
// differ between the two renders. What must not differ is which row
// comes before which.
async function readSectionOrder() {
  const nav = await screen.findByRole('navigation', { name: 'Server sections' })
  const links = within(nav).getAllByRole('link')
  return links.map(link => link.getAttribute('href') || '')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Dashboard.tsx: work-item row order stability across an RCON-only status change (GH#137)', () => {
  it('Console going from connected to disconnected (Stop/Restart) does not reorder the other rows', async () => {
    await setUpCommon(true)
    renderDashboard()
    const connectedOrder = await readSectionOrder()
    cleanup()
    vi.clearAllMocks()

    await setUpCommon(false)
    renderDashboard()
    const disconnectedOrder = await readSectionOrder()

    expect(disconnectedOrder).toEqual(connectedOrder)
  })
})
