import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from '@/lib/routerCompat'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'


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
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
      getWhitelist: vi.fn(),
      getPerks: vi.fn(),
      getAccessLevels: vi.fn(),
      getSteamIdBans: vi.fn(),
      getNotes: vi.fn(),
      getStats: vi.fn(),
      getExports: vi.fn(),
      getActivityLogs: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
      getPlayerDetails: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getWhitelist = vi.mocked(playersApi.getWhitelist)
const getPerks = vi.mocked(playersApi.getPerks)
const getAccessLevels = vi.mocked(playersApi.getAccessLevels)
const getSteamIdBans = vi.mocked(playersApi.getSteamIdBans)
const getNotes = vi.mocked(playersApi.getNotes)
const getStats = vi.mocked(playersApi.getStats)
const getExports = vi.mocked(playersApi.getExports)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getPlayerDetails = vi.mocked(panelBridgeApi.getPlayerDetails)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUpFixtures(bridgeConnected: boolean) {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected: bridgeConnected, isRunning: bridgeConnected } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayerAndOpenVitals() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Vitals' }), { button: 0 })
}

describe('Players.tsx Vitals tab: PanelBridge.getPlayerDetails now has a real UI consumer', () => {
  it('shows real position, HP, hunger/thirst/fatigue, and status badges for an online player with the bridge up', async () => {
    await setUpFixtures(true)
    getPlayerDetails.mockResolvedValue({
      success: true,
      data: {
        x: 10123, y: 9876, z: 0,
        accessLevel: 'admin',
        isAsleep: false,
        isSneaking: false,
        isRunning: false,
        stats: { hunger: 0.62, thirst: 0.18, fatigue: 0.4, stress: 5, boredom: 0.3, unhappiness: 0.05, pain: 0, endurance: 0.8 },
        health: { overallBodyHealth: 85, isInfected: true, isBleeding: false, temperature: 37, wetness: 0.2 },
      },
    } as Awaited<ReturnType<typeof panelBridgeApi.getPlayerDetails>>)

    renderPlayers()
    await selectTestPlayerAndOpenVitals()

    await waitFor(() => expect(getPlayerDetails).toHaveBeenCalledWith('TestPlayer'))

    expect(await screen.findByText('85%')).toBeInTheDocument()
    expect(screen.getByText('62%')).toBeInTheDocument()
    expect(screen.getByText('18%')).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.getByText('Infected')).toBeInTheDocument()
    expect(screen.getByText('10123, 9876, 0')).toBeInTheDocument()
    expect(screen.getByText('0.8')).toBeInTheDocument()
  })

  it('shows the offline message and never calls getPlayerDetails for a previously-seen (offline) player', async () => {
    await setUpFixtures(true)
    getStats.mockResolvedValue({
      stats: [{ player_name: 'GhostPlayer', total_playtime_seconds: 100, session_count: 1, first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z' }],
    })
    renderPlayers()

    await waitFor(() => expect(screen.getAllByText('Roster').some(el => el.closest('button'))).toBe(true), { timeout: 3000 })
    fireEvent.click(screen.getAllByText('Roster').find(el => el.closest('button'))!)
    await waitFor(() => expect(screen.getByText('GhostPlayer')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getByText('GhostPlayer'))
    await waitFor(() => expect(screen.getAllByText('GhostPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Vitals' }), { button: 0 })

    expect(await screen.findByText('This player is offline.')).toBeInTheDocument()
    expect(getPlayerDetails).not.toHaveBeenCalled()
  })

  it('shows the bridge-required message and never calls getPlayerDetails when PanelBridge is disconnected', async () => {
    await setUpFixtures(false)
    renderPlayers()
    await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getByText('TestPlayer'))
    await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Vitals' }), { button: 0 })

    expect(await screen.findByText('PanelBridge is not connected.')).toBeInTheDocument()
    expect(getPlayerDetails).not.toHaveBeenCalled()
  })
})
