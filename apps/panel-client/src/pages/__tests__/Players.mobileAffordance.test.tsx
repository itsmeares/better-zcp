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
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPlayers(initialEntries = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
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
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({
    logs: [{ id: 1, player_name: 'TestPlayer', action: 'kick', details: 'Reason: griefing base', logged_at: '2026-08-31T00:00:00.000Z' }],
  })
  getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayer() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
}

describe('Players.tsx dossier: mobile-affordance fixes', () => {
  it('opens the requested player when linked from the World Map dossier', async () => {
    await setUpFixtures()
    renderPlayers(['/players?player=TestPlayer'])

    await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
    expect(screen.getByRole('tab', { name: 'Vitals' })).toBeInTheDocument()
  })

  it('#4 tab strip wraps instead of clipping into a horizontal scroller', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    const tabs = ['Vitals', 'Moderation', 'Spawn', 'Powers', 'Notes & Log'].map(
      (name) => screen.getByRole('tab', { name }),
    )
    for (const tab of tabs) {
      expect(tab).toBeInTheDocument()
      expect(tab.closest('[class*="overflow-x-auto"]')).toBeNull()
    }
    const tabList = screen.getByRole('tablist')
    expect(tabList.className).toContain('flex-wrap')
  })

  it('#3 Moderation action-tile descriptions clamp to 2 lines instead of truncating to 1', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Moderation' }), { button: 0 })

    const banDesc = await screen.findByText('Permanent · two-step')
    expect(banDesc.className).toContain('line-clamp-2')
    expect(banDesc.className).not.toMatch(/\btruncate\b/)

    const teleportDesc = screen.getByText('Build 42 multiplayer · may not sync')
    expect(teleportDesc.className).toContain('line-clamp-2')
  })

  it('#3b Spawn tab Give Items / Spawn Vehicles descriptions clamp to 2 lines instead of truncating to 1', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Spawn' }), { button: 0 })

    const giveItemsDesc = (await screen.findByText('Give items')).closest('div.flex-1')!.querySelector('p:last-child')!
    expect(giveItemsDesc.className).toContain('line-clamp-2')
    expect(giveItemsDesc.className).not.toMatch(/\btruncate\b/)

    const spawnVehiclesDesc = screen.getByText('Spawn vehicles').closest('div.flex-1')!.querySelector('p:last-child')!
    expect(spawnVehiclesDesc.className).toContain('line-clamp-2')
    expect(spawnVehiclesDesc.className).not.toMatch(/\btruncate\b/)
  })

  it('#7 Activity Log details are reachable even where the dedicated column is hidden', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    const notesTab = screen.getByRole('tab', { name: 'Notes & Log' })
    fireEvent.mouseDown(notesTab, { button: 0 })
    fireEvent.click(notesTab)

    const matches = await screen.findAllByText('Reason: griefing base')
    expect(matches.length).toBe(2)
    expect(matches.some((el) => el.className.includes('sm:hidden'))).toBe(true)
    expect(matches.some((el) => el.className.includes('sm:table-cell'))).toBe(true)
  })
})
