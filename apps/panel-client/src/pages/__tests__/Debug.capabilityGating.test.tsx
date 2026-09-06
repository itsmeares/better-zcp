import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { getRequiredCapabilityForCheck } from '../Debug'
import Debug from '../Debug'
import { apiFetch, modsApi, serverApi, rconApi, backupApi, panelBridgeApi, serverFilesApi } from '@/lib/api'

// bug-hunt-2026-08-26/27: Jim's catalogue (catalogue-debug-tsx-destructive-
// auto-fixes) confirmed all 11 automated diagnostics fixes are already
// gated server-side, across SEVEN distinct capabilities (not one page-level
// concern) -- verified here by reading each route's requirePermission call
// directly: mods.* fixes -> mods.manage (mods.js's router.use), server.process
// -> server.control, rcon.connected -> rcon.execute, db.backup ->
// backups.manage, server.staleLocks -> diagnostics.manage, bridge.configured/
// worldmap.bridge.configured -> bridge.setup, server.sandboxCorrupt ->
// serverfiles.manage. Debug.tsx itself had zero client-side awareness of any
// of them. All 11 fixes share ONE render site and ONE handler
// (handleDiagnosticsFix) -- a native <button>, not a Radix menu item, so the
// Radix disabled-doesn't-gate-onClick trap doesn't apply here, but the
// handler is guarded anyway (defense in depth, same two-layer pattern as
// every other page tonight).

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    apiFetch: vi.fn(),
    modsApi: { ...actual.modsApi, batchToggleModIds: vi.fn() },
    serverApi: { ...actual.serverApi, start: vi.fn() },
    rconApi: { ...actual.rconApi, connect: vi.fn() },
    backupApi: { ...actual.backupApi, createBackup: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, autoConfigure: vi.fn() },
    serverFilesApi: { ...actual.serverFilesApi, repairSandbox: vi.fn() },
  }
})

const mockedApiFetch = vi.mocked(apiFetch)
const batchToggleModIds = vi.mocked(modsApi.batchToggleModIds)
const serverStart = vi.mocked(serverApi.start)
const rconConnect = vi.mocked(rconApi.connect)
const createBackup = vi.mocked(backupApi.createBackup)
const bridgeAutoConfigure = vi.mocked(panelBridgeApi.autoConfigure)
const repairSandbox = vi.mocked(serverFilesApi.repairSandbox)

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

const diagnosticsFixture = {
  timestamp: '2026-08-27T00:00:00.000Z',
  overall: 'fail',
  summary: { ok: 0, warn: 0, fail: 7, info: 0, skip: 0 },
  categories: {
    mods: { label: 'Mods', order: 1 },
    server: { label: 'Server', order: 2 },
  },
  checks: [
    {
      id: 'mods.numericInMods',
      label: 'Numeric mod IDs',
      status: 'fail',
      severity: 'warning',
      message: 'Some mods use numeric-only IDs.',
      category: 'mods',
      meta: { numericInMods: ['12345', '67890'] },
    },
    {
      id: 'server.staleLocks',
      label: 'Stale lock files',
      status: 'fail',
      severity: 'critical',
      message: 'Stale lock files found under the save directory.',
      category: 'server',
    },
    {
      id: 'server.process',
      label: 'Server not running',
      status: 'fail',
      severity: 'critical',
      message: 'The server process is not running.',
      category: 'server',
    },
    {
      id: 'rcon.connected',
      label: 'RCON not connected',
      status: 'fail',
      severity: 'warning',
      message: 'RCON is not connected.',
      category: 'server',
    },
    {
      id: 'db.backup',
      label: 'No recent database backup',
      status: 'fail',
      severity: 'warning',
      message: 'No recent backup was found.',
      category: 'server',
    },
    {
      id: 'bridge.configured',
      label: 'Bridge not configured',
      status: 'fail',
      severity: 'warning',
      message: 'The panel bridge is not configured.',
      category: 'server',
    },
    {
      id: 'server.sandboxCorrupt',
      label: 'SandboxVars corrupt',
      status: 'fail',
      severity: 'critical',
      message: 'SandboxVars.lua is corrupt.',
      category: 'server',
    },
    {
      id: 'server.recentCrash',
      label: 'Recent crash detected',
      status: 'fail',
      severity: 'warning',
      message: 'A recent crash was detected in the server log.',
      category: 'server',
    },
  ],
  durationMs: 5,
}

function setUpApiFetch() {
  mockedApiFetch.mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('/debug/diagnostics')) return jsonResponse(diagnosticsFixture)
    if (endpoint.startsWith('/debug/clear-stale-locks')) return jsonResponse({ success: true, deleted: 3 })
    // Every other mount-time fetch (system/health/logs/logs-files/crash-logs)
    // -- return a generically-shaped empty success so those unrelated
    // fetchers don't error and spam reportClientError during the test.
    return jsonResponse({})
  })
}

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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

describe('getRequiredCapabilityForCheck: maps every automated fix to its actual server-verified capability', () => {
  it('maps the four mods.* fixes to mods.manage', () => {
    for (const id of ['mods.numericInMods', 'mods.orphanWorkshop', 'mods.maps', 'mods.duplicates']) {
      expect(getRequiredCapabilityForCheck(id)).toBe('mods.manage')
    }
  })

  it('maps server.process to server.control, rcon.connected to rcon.execute, db.backup to backups.manage', () => {
    expect(getRequiredCapabilityForCheck('server.process')).toBe('server.control')
    expect(getRequiredCapabilityForCheck('rcon.connected')).toBe('rcon.execute')
    expect(getRequiredCapabilityForCheck('db.backup')).toBe('backups.manage')
  })

  it('maps server.staleLocks to diagnostics.manage, bridge fixes to bridge.setup, sandbox repair to serverfiles.manage', () => {
    expect(getRequiredCapabilityForCheck('server.staleLocks')).toBe('diagnostics.manage')
    expect(getRequiredCapabilityForCheck('bridge.configured')).toBe('bridge.setup')
    expect(getRequiredCapabilityForCheck('worldmap.bridge.configured')).toBe('bridge.setup')
    expect(getRequiredCapabilityForCheck('server.sandboxCorrupt')).toBe('serverfiles.manage')
  })

  it('needs no capability for the one automated fix that makes no API call, or for any non-automated/unknown check', () => {
    expect(getRequiredCapabilityForCheck('server.recentCrash')).toBeNull()
    expect(getRequiredCapabilityForCheck('mods.resolved')).toBeNull()
    expect(getRequiredCapabilityForCheck('some.unknown.check.id')).toBeNull()
  })
})

describe('Debug.tsx: automated fixes are gated on their own capability, not one page-level concern', () => {
  it('lacking mods.manage: the numeric-mod-IDs fix is disabled and never calls the API', async () => {
    mockCan = (capability) => capability !== 'mods.manage'
    setUpApiFetch()

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /numeric/i })
    expect(fixButton).toBeDisabled()

    fireEvent.click(fixButton)
    expect(batchToggleModIds).not.toHaveBeenCalled()
  })

  it('holding mods.manage: the numeric-mod-IDs fix is enabled and actually calls the API', async () => {
    mockCan = () => true
    setUpApiFetch()
    batchToggleModIds.mockResolvedValue({ success: true, changed: 2, totalMods: 10 })

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /numeric/i })
    expect(fixButton).not.toBeDisabled()

    fireEvent.click(fixButton)
    await waitFor(() => expect(batchToggleModIds).toHaveBeenCalledTimes(1))
  })

  it('lacking diagnostics.manage: the stale-locks fix (which always confirms) is disabled, and clicking it never even opens the confirm dialog', async () => {
    mockCan = (capability) => capability !== 'diagnostics.manage'
    setUpApiFetch()

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /stale lock/i })
    expect(fixButton).toBeDisabled()

    fireEvent.click(fixButton)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(mockedApiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/debug/clear-stale-locks'),
      expect.anything(),
    )
  })

  it('holding diagnostics.manage: the stale-locks fix opens its confirm dialog and actually calls the clear-stale-locks route once confirmed', async () => {
    mockCan = () => true
    setUpApiFetch()

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /stale lock/i })
    expect(fixButton).not.toBeDisabled()

    fireEvent.click(fixButton)
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /apply/i }))

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/debug/clear-stale-locks',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })
})

// god (2026-08-27, bug-hunt-2026-08-26): "the failure mode here is gating a
// fix on the wrong one of the seven, which no disabled-state assertion can
// detect either." The two suites above prove the wiring is generic and
// correct for mods.manage + diagnostics.manage; this suite proves it holds
// for the remaining five capabilities too, each one clicking all the way
// through to its OWN real (mocked) API call -- not just "not disabled."
describe('Debug.tsx: every automated fix reaches its own real API when granted its own capability (not a neighbor\'s)', () => {
  it('server.control: the server-not-running fix calls serverApi.start', async () => {
    mockCan = () => true
    setUpApiFetch()
    serverStart.mockResolvedValue({ success: true, message: 'Starting...' })

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /start server/i })
    expect(fixButton).not.toBeDisabled()

    fireEvent.click(fixButton)
    await waitFor(() => expect(serverStart).toHaveBeenCalledTimes(1))
  })

  it('server.control withheld: the server-not-running fix is disabled and never calls serverApi.start', async () => {
    mockCan = (capability) => capability !== 'server.control'
    setUpApiFetch()

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /start server/i })
    expect(fixButton).toBeDisabled()

    fireEvent.click(fixButton)
    expect(serverStart).not.toHaveBeenCalled()
  })

  it('rcon.execute: the RCON-disconnected fix calls rconApi.connect', async () => {
    mockCan = () => true
    setUpApiFetch()
    rconConnect.mockResolvedValue({ success: true, connected: true, message: 'Connected' })

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /reconnect rcon/i })
    expect(fixButton).not.toBeDisabled()

    fireEvent.click(fixButton)
    await waitFor(() => expect(rconConnect).toHaveBeenCalledTimes(1))
  })

  it('rcon.execute withheld: the RCON-disconnected fix is disabled and never calls rconApi.connect', async () => {
    mockCan = (capability) => capability !== 'rcon.execute'
    setUpApiFetch()

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /reconnect rcon/i })
    expect(fixButton).toBeDisabled()

    fireEvent.click(fixButton)
    expect(rconConnect).not.toHaveBeenCalled()
  })

  it('backups.manage: the no-recent-backup fix calls backupApi.createBackup', async () => {
    mockCan = () => true
    setUpApiFetch()
    createBackup.mockResolvedValue({ success: true, backup: { name: 'backup-1.json' } })

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /create database backup/i })
    expect(fixButton).not.toBeDisabled()

    fireEvent.click(fixButton)
    await waitFor(() => expect(createBackup).toHaveBeenCalledWith(expect.objectContaining({ includeDb: true })))
  })

  it('backups.manage withheld: the no-recent-backup fix is disabled and never calls backupApi.createBackup', async () => {
    mockCan = (capability) => capability !== 'backups.manage'
    setUpApiFetch()

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /create database backup/i })
    expect(fixButton).toBeDisabled()

    fireEvent.click(fixButton)
    expect(createBackup).not.toHaveBeenCalled()
  })

  it('bridge.setup: the bridge-not-configured fix calls panelBridgeApi.autoConfigure', async () => {
    mockCan = () => true
    setUpApiFetch()
    bridgeAutoConfigure.mockResolvedValue({ success: true, serverName: 'MyServer' })

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /auto-configure bridge/i })
    expect(fixButton).not.toBeDisabled()

    fireEvent.click(fixButton)
    await waitFor(() => expect(bridgeAutoConfigure).toHaveBeenCalledTimes(1))
  })

  it('bridge.setup withheld: the bridge-not-configured fix is disabled and never calls panelBridgeApi.autoConfigure', async () => {
    mockCan = (capability) => capability !== 'bridge.setup'
    setUpApiFetch()

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /auto-configure bridge/i })
    expect(fixButton).toBeDisabled()

    fireEvent.click(fixButton)
    expect(bridgeAutoConfigure).not.toHaveBeenCalled()
  })

  it('serverfiles.manage: the sandbox-corrupt fix calls serverFilesApi.repairSandbox', async () => {
    mockCan = () => true
    setUpApiFetch()
    repairSandbox.mockResolvedValue({ success: true, alreadyValid: false, message: 'Repaired.', changes: ['fixed brace'] })

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /repair sandboxvars/i })
    expect(fixButton).not.toBeDisabled()

    fireEvent.click(fixButton)
    await waitFor(() => expect(repairSandbox).toHaveBeenCalledTimes(1))
  })

  it('serverfiles.manage withheld: the sandbox-corrupt fix is disabled and never calls serverFilesApi.repairSandbox', async () => {
    mockCan = (capability) => capability !== 'serverfiles.manage'
    setUpApiFetch()

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /repair sandboxvars/i })
    expect(fixButton).toBeDisabled()

    fireEvent.click(fixButton)
    expect(repairSandbox).not.toHaveBeenCalled()
  })
})

// god (2026-08-27): "Gating a control that needs no capability hides a
// working button, which is the same class of harm as leaving a real one
// open." server.recentCrash's automated fix only calls setActiveTab -- no
// API, no capability -- so it must stay enabled even when every capability
// is withheld.
describe('Debug.tsx: the one automated fix with no API call is never gated', () => {
  it('server.recentCrash stays enabled and switches tabs even when every capability is withheld', async () => {
    mockCan = () => false
    setUpApiFetch()

    renderDebug()

    const fixButton = await screen.findByRole('button', { name: /view crash logs/i })
    expect(fixButton).not.toBeDisabled()

    fireEvent.click(fixButton)
    await waitFor(() => expect(screen.getByRole('tab', { name: /crash/i })).toHaveAttribute('aria-selected', 'true'))
  })
})

// god (2026-08-27): "EVERY read endpoint in debug.js requires
// diagnostics.manage ... SO TODAY A USER WITHOUT diagnostics.manage OPENS
// DEBUG AND GETS A WALL OF 403s." Per-fix gating (above) answers "which
// buttons work"; this answers "why is this page broken" -- a real 403 from
// the mount-time diagnostics fetch replaces the whole Tabs UI with one
// clean permission-denied state, same precedent as Users.tsx/
// RolesPermissions.tsx/OidcSettings.tsx (react to the server's actual
// answer, not a client-side can() guess).
describe('Debug.tsx: a 403 from the diagnostics fetch replaces the whole page, not just one tab', () => {
  it('shows the permission-denied empty state and never renders the Tabs UI when /debug/diagnostics returns 403', async () => {
    mockCan = () => true
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/diagnostics')) return jsonResponse({ error: 'Forbidden' }, false, 403)
      return jsonResponse({})
    })

    renderDebug()

    expect(await screen.findByText(/can't view debug diagnostics/i)).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /view crash logs/i })).not.toBeInTheDocument()
  })

  it('renders the normal Tabs UI (not the permission-denied state) when /debug/diagnostics returns 200', async () => {
    mockCan = () => true
    setUpApiFetch()

    renderDebug()

    expect(await screen.findByRole('tablist')).toBeInTheDocument()
    expect(screen.queryByText(/can't view debug diagnostics/i)).not.toBeInTheDocument()
  })
})

// kevin-2026-08-30 (god's follow-up on af4c0c10, the PanelBridge tab): its
// data is gated on bridge.diagnostics specifically -- narrower than
// whatever gates this page as a whole (diagnostics.manage, tested above).
// A role can hold diagnostics.manage (sees the page, the suite above stays
// green) but lack bridge.diagnostics (must still not see this ONE tab's
// data). Same reasoning as the page-wide 403 suite: react to the server's
// real 403 from a bridge.diagnostics-gated route (bridgeDiagFetch), not a
// client-side can() guess -- the tab's own scoped permission-denied state
// replaces its cards, the rest of the page (and the other tabs) are
// unaffected.
describe('Debug.tsx: the PanelBridge tab gates its own data on bridge.diagnostics, separate from the page-wide gate', () => {
  it('shows the tab-scoped permission-denied state and never renders the Stats card when a bridge.diagnostics route returns 403', async () => {
    mockCan = () => true
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/diagnostics')) return jsonResponse(diagnosticsFixture)
      if (endpoint.startsWith('/panel-bridge/status')) {
        return jsonResponse({ isRunning: true, modConnected: true })
      }
      if (endpoint.startsWith('/panel-bridge/debug/stats')) {
        return jsonResponse({ error: 'Insufficient permissions', code: 'PERMISSION_DENIED' }, false, 403)
      }
      return jsonResponse({})
    })

    renderDebug()

    // jsdom's fireEvent.click does not move focus the way a real click
    // does, and Radix Tabs' default activationMode="automatic" selects a
    // tab on FOCUS, not on click -- a bare fireEvent.click here leaves the
    // tab permanently unselected (confirmed empirically: aria-selected
    // stayed "false" without the explicit .focus() call). Same shape as
    // the Radix Select workaround documented in
    // Chat.capabilityGating.test.tsx, different root cause.
    const tab = await screen.findByRole('tab', { name: /panelbridge/i })
    tab.focus()
    fireEvent.click(tab)

    expect(await screen.findByText(/can't view bridge diagnostics/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^stats$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument()
  })

  it('renders the real Stats card (not the permission-denied state) when the bridge.diagnostics routes succeed', async () => {
    mockCan = () => true
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/diagnostics')) return jsonResponse(diagnosticsFixture)
      if (endpoint.startsWith('/panel-bridge/status')) {
        return jsonResponse({ isRunning: true, modConnected: true, connection: { canSendCommands: true } })
      }
      if (endpoint.startsWith('/panel-bridge/debug/stats')) {
        return jsonResponse({
          success: true,
          data: {
            version: '1.7.40',
            uptime: 120,
            commandsProcessed: 10,
            commandsSucceeded: 9,
            commandsFailed: 1,
            debugMode: false,
            lastError: null,
            recentErrors: [],
            detectedVersion: { build: '42.13.1', isB42: true, isB41: false, features: {} },
          },
        })
      }
      return jsonResponse({})
    })

    renderDebug()

    const tab = await screen.findByRole('tab', { name: /panelbridge/i })
    tab.focus()
    fireEvent.click(tab)

    expect(await screen.findByText('1.7.40')).toBeInTheDocument()
    expect(screen.queryByText(/can't view bridge diagnostics/i)).not.toBeInTheDocument()
  })
})
