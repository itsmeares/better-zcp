import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// 2026-08-31 impeccable pass, ruling from god: God Mode/Invisible/Noclip had
// no fetch that ever populates their real current state (playerPowers only
// gets an entry AFTER the operator has toggled one of the three this
// session, via the optimistic update in handleGodMode/handleInvisible/
// handleNoclip) -- so selectedPlayerPowers?.godMode is undefined on every
// page load, for every player, until the operator's first click. Before this
// fix, "never reported" and a confirmed "off" rendered identically: no
// badge, and the button always read "Enable". That's irritant 1 in its
// purest form -- the operator can't tell "confirmed off" from "we don't
// know" -- and it isn't a rare edge case, it's the default state.
// Fix: a third badge state (UNKNOWN, distinct from ON/OFF), and instead of
// one toggle button silently assuming "currently off", two explicit buttons
// (Enable / Disable) so each offered action's own outcome stays predictable
// rather than the UI guessing a direction on the operator's behalf.

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
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)
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
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayerAndOpenPowers() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Players.tsx: Powers tab distinguishes "confirmed off" from "state never reported"', () => {
  it('shows an UNKNOWN badge and both Enable and Disable buttons for a freshly-selected player, before any toggle this session', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayerAndOpenPowers()

    expect(screen.getAllByText('UNKNOWN')).toHaveLength(3)
    // "Enable" appears once per row (God Mode, Invisible, Noclip) -- same
    // count the pre-fix single-button UI already had, so this alone
    // wouldn't have caught the regression; the UNKNOWN badge assertion
    // above and the Disable-button assertion below are what do.
    expect(screen.getAllByRole('button', { name: 'Enable' })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(3)
  })

  it('Enable and Disable each send their own predictable, opposite command -- neither guesses the current state', async () => {
    sendCommand.mockResolvedValue({ success: true, data: {} } as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayerAndOpenPowers()

    const godModeRow = screen.getByText('God Mode').closest('div.rounded-xl') as HTMLElement
    fireEvent.click(within(godModeRow).getByRole('button', { name: 'Enable' }))
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setGodMode', { username: 'TestPlayer', enabled: true }))

    sendCommand.mockClear()
    fireEvent.click(within(godModeRow).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setGodMode', { username: 'TestPlayer', enabled: false }))
  })

  it('collapses back to a single toggle button with an ON/OFF badge once the bridge confirms a toggle', async () => {
    sendCommand.mockResolvedValue({ success: true, data: { verified: 'confirmed' } } as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayerAndOpenPowers()

    const godModeRow = screen.getByText('God Mode').closest('div.rounded-xl') as HTMLElement
    fireEvent.click(within(godModeRow).getByRole('button', { name: 'Enable' }))

    await waitFor(() => expect(within(godModeRow).getByText('ON')).toBeInTheDocument())
    expect(within(godModeRow).queryByText('UNKNOWN')).not.toBeInTheDocument()
    expect(within(godModeRow).queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
    expect(within(godModeRow).getByRole('button', { name: 'Disable' })).toBeInTheDocument()
  })
})
