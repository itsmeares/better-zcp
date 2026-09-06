import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// wired-no-ui-2026-08-30: getAllPlayerDetails (GET /panel-bridge/players --
// the PLURAL bulk endpoint, distinct from getPlayerDetails, which is one
// player at a time and drives the Vitals tab) had a live, gated route and
// Lua handler but zero client callers. The roster list itself comes from
// RCON's `players` command, which reports only {name, online} -- no health,
// hunger, or infection data at all (apps/panel-server/services/rcon.js's parsePlayers),
// so an at-a-glance health indicator per roster row is genuinely new data,
// not a second view of something the roster already shows. Gated on
// players.gm_tools -- the SAME capability the route itself requires, not
// players.view (which the base roster list uses) -- so this proves the read
// is denied to a role that only holds players.view, matching the server
// gate exactly rather than a client-invented one.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
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
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUpFixtures() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Players.tsx: roster health indicator (getAllPlayerDetails)', () => {
  it('is not fetched at all when the role lacks players.gm_tools, even though it holds players.view', async () => {
    mockCan = (capability) => capability === 'players.view'
    await setUpFixtures()
    getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)

    renderPlayers()

    await screen.findByText('TestPlayer')
    expect(getAllPlayerDetails).not.toHaveBeenCalled()
    expect(screen.queryByTitle(/Health:/)).not.toBeInTheDocument()
  })

  it('shows nothing before the fetch resolves -- no seeded 0% default', async () => {
    mockCan = () => true
    await setUpFixtures()
    getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)

    renderPlayers()

    await screen.findByText('TestPlayer')
    expect(screen.queryByTitle(/Health:/)).not.toBeInTheDocument()
  })

  it('shows the real fetched health percentage and infected marker once granted', async () => {
    mockCan = () => true
    await setUpFixtures()
    getAllPlayerDetails.mockResolvedValue({
      success: true,
      data: { players: [{ username: 'TestPlayer', displayName: 'TestPlayer', x: 0, y: 0, z: 0, accessLevel: 'user', isAlive: true, health: 42, isInfected: true }] },
    } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)

    renderPlayers()

    await waitFor(() => expect(screen.getByTitle('Health: 42%')).toBeInTheDocument())
    expect(screen.getByText('42%')).toBeInTheDocument()
  })
})
