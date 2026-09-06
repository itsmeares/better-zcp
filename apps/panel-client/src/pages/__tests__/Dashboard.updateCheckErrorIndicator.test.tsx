import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi,
} from '@/lib/api'

// updater-mystery-2026-08-29: a persistently-failing GET /api/panel/status
// check exposes lastError correctly, but until this card Dashboard.tsx only
// ever looked at updateAvailable for its banner -- a failing check produced
// a clean server log line and ZERO signal anywhere on the page an operator
// actually looks at. Deliberately NOT the accented-banner treatment (that
// was the operator's own call, made explicitly: silence is correct for an
// intentionally air-gapped install, so this must be quiet enough to dismiss
// once and never fight the operator again -- see the dismissal-key tests
// below for the constraint that a dismissal must NOT survive a genuinely
// DIFFERENT failure showing up later).

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
  return {
    ...actual,
    serverApi: {
      ...actual.serverApi,
      getStatus: vi.fn(),
      getPanelInfo: vi.fn(),
      getConsoleErrorCount: vi.fn(),
    },
    serversApi: {
      ...actual.serversApi,
      getComposedStatus: vi.fn(),
      getResolvedActive: vi.fn(),
    },
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
      getActivityLogs: vi.fn(),
    },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
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

async function setUpCommon() {
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getResolvedActive.mockResolvedValue({ server: null })
  getStatus.mockResolvedValue({
    running: false, startTime: null, uptime: 0, serverPath: null,
    serverPathConfigured: false, rcon: { host: '', port: 0, connected: false },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getBridgeStatus.mockResolvedValue({ configured: false, isRunning: false, modConnected: false, modStatus: null })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: false, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 1 })
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 })
  getSchedulerTasks.mockResolvedValue({ tasks: [] })
  getSchedulerStatus.mockResolvedValue({ nextRun: null })
  getPerformanceHistory.mockResolvedValue({ history: [] })
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

const INDICATOR_TEXT = "Can't check for panel updates"
const DISMISS_KEY = 'pz-panel-update-error-dismissed'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Dashboard.tsx: quiet update-check-error indicator', () => {
  it('does not appear when the last check succeeded (no lastError)', async () => {
    await setUpCommon()
    getPanelUpdateStatus.mockResolvedValue({
      currentVersion: '1.2.6', updateAvailable: false, latestVersion: null, releaseUrl: null,
      releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
      downloadProgress: 0, lastCheck: new Date().toISOString(), lastError: null,
      stagedUpdate: null, lastApplyResult: null,
    })

    renderDashboard()

    await screen.findAllByRole('button', { name: 'Start' })
    expect(screen.queryByText(INDICATOR_TEXT)).not.toBeInTheDocument()
  })

  it('does not appear when an update IS available, even though the server never sets lastError in that case', async () => {
    await setUpCommon()
    getPanelUpdateStatus.mockResolvedValue({
      currentVersion: '1.2.6', updateAvailable: true, latestVersion: '1.2.9', releaseUrl: null,
      releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
      downloadProgress: 0, lastCheck: new Date().toISOString(), lastError: null,
      stagedUpdate: null, lastApplyResult: null,
    })

    renderDashboard()

    await screen.findAllByRole('button', { name: 'Start' })
    expect(screen.queryByText(INDICATOR_TEXT)).not.toBeInTheDocument()
  })

  it('appears when the last check failed and no update is available', async () => {
    await setUpCommon()
    getPanelUpdateStatus.mockResolvedValue({
      currentVersion: '1.2.6', updateAvailable: false, latestVersion: null, releaseUrl: null,
      releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
      downloadProgress: 0, lastCheck: new Date().toISOString(),
      lastError: 'getaddrinfo EAI_AGAIN api.github.com',
      stagedUpdate: null, lastApplyResult: null,
    })

    renderDashboard()

    expect(await screen.findByText(INDICATOR_TEXT)).toBeInTheDocument()
  })

  it('dismissing it persists in localStorage and it stays gone across a reload (remount)', async () => {
    await setUpCommon()
    getPanelUpdateStatus.mockResolvedValue({
      currentVersion: '1.2.6', updateAvailable: false, latestVersion: null, releaseUrl: null,
      releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
      downloadProgress: 0, lastCheck: new Date().toISOString(),
      lastError: 'connect ECONNREFUSED 127.0.0.1:443',
      stagedUpdate: null, lastApplyResult: null,
    })

    const first = renderDashboard()
    const dismissBtn = await screen.findByRole('button', { name: /dismiss update check notice/i })
    dismissBtn.click()

    await waitFor(() => expect(screen.queryByText(INDICATOR_TEXT)).not.toBeInTheDocument())
    expect(localStorage.getItem(DISMISS_KEY)).toBe('connect ECONNREFUSED 127.0.0.1:443')

    // Simulate a reload: unmount and render a fresh Dashboard instance.
    // The initial GET /api/panel/status still returns the SAME lastError.
    first.unmount()
    renderDashboard()

    await screen.findAllByRole('button', { name: 'Start' })
    expect(screen.queryByText(INDICATOR_TEXT)).not.toBeInTheDocument()
  })

  it('a dismissal does not suppress a DIFFERENT failure that shows up later', async () => {
    localStorage.setItem(DISMISS_KEY, 'connect ECONNREFUSED 127.0.0.1:443')
    await setUpCommon()
    getPanelUpdateStatus.mockResolvedValue({
      currentVersion: '1.2.6', updateAvailable: false, latestVersion: null, releaseUrl: null,
      releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
      downloadProgress: 0, lastCheck: new Date().toISOString(),
      // Machine got network access since the dismissal; a real, different
      // problem (rate limiting) shows up now. Must not stay suppressed by
      // the old dismissal of a completely different error string.
      lastError: 'GitHub API rate limited',
      stagedUpdate: null, lastApplyResult: null,
    })

    renderDashboard()

    expect(await screen.findByText(INDICATOR_TEXT)).toBeInTheDocument()
  })
})
