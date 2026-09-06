import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'


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
      kick: vi.fn(),
      ban: vi.fn(),
      unban: vi.fn(),
      unbanSteamId: vi.fn(),
      banSteamId: vi.fn(),
      voiceBan: vi.fn(),
      addUser: vi.fn(),
      addAllowedSteamId: vi.fn(),
      removeAllowedSteamId: vi.fn(),
      removeFromWhitelist: vi.fn(),
      setAccessLevel: vi.fn(),
      saveNote: vi.fn(),
      deleteNote: vi.fn(),
      teleport: vi.fn(),
      addItem: vi.fn(),
      addVehicle: vi.fn(),
      addXp: vi.fn(),
      getExport: vi.fn(),
      deleteExport: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
      exportCharacter: vi.fn(),
      importCharacter: vi.fn(),
      killPlayer: vi.fn(),
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
const kick = vi.mocked(playersApi.kick)
const ban = vi.mocked(playersApi.ban)
const unban = vi.mocked(playersApi.unban)
const unbanSteamId = vi.mocked(playersApi.unbanSteamId)
const banSteamId = vi.mocked(playersApi.banSteamId)
const voiceBan = vi.mocked(playersApi.voiceBan)
const addUser = vi.mocked(playersApi.addUser)
const addAllowedSteamId = vi.mocked(playersApi.addAllowedSteamId)
const removeAllowedSteamId = vi.mocked(playersApi.removeAllowedSteamId)
const removeFromWhitelist = vi.mocked(playersApi.removeFromWhitelist)
const setAccessLevel = vi.mocked(playersApi.setAccessLevel)
const saveNote = vi.mocked(playersApi.saveNote)
const deleteNote = vi.mocked(playersApi.deleteNote)
const teleport = vi.mocked(playersApi.teleport)
const addItem = vi.mocked(playersApi.addItem)
const addVehicle = vi.mocked(playersApi.addVehicle)
const addXp = vi.mocked(playersApi.addXp)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)
const killPlayer = vi.mocked(panelBridgeApi.killPlayer)
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

async function setUpFixtures() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({
    success: true,
    available: true,
    accounts: [{ id: 1, username: 'TestPlayer', lastConnection: null, role: 'user', authType: 0, steamId: null, ownerId: null, displayName: null }],
    allowedSteamIds: ['76561198000000001'],
  })
  getPerks.mockResolvedValue({ catalog: [{ id: 'Sprinting', label: 'Sprinting', category: 'Combat' }] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [{ steamId: '76561198000000002', banned_at: new Date().toISOString() }] })
  getNotes.mockResolvedValue({ notes: [{ playerName: 'TestPlayer', note: 'existing note', tags: [], updated_at: new Date().toISOString() }] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayer() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
}

async function openMoreActionsMenu() {
  const trigger = await screen.findByRole('button', { name: 'More player actions' })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

describe('Players.tsx: capability gating', () => {
  it('disables every gated trigger, and clicking any of them never calls the API, when the role holds none of the three capabilities', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    const kickButtons = screen.getAllByRole('button', { name: /^Kick\b/ })
    expect(kickButtons).toHaveLength(2)
    kickButtons.forEach(b => expect(b).toBeDisabled())

    const banButtons = screen.getAllByRole('button', { name: /^Ban\b/ })
    expect(banButtons).toHaveLength(2)
    banButtons.forEach(b => expect(b).toBeDisabled())

    expect(screen.getByRole('button', { name: /^Access Level\b/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Voice Ban' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'SteamID Ban' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add User' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unban' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unban SteamID' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /View \d+ banned SteamIDs/ })).toBeDisabled()

    // Teleport is players.gm_tools, not players.moderate -- confirm it is
    // NOT disabled by the moderate-less role in this pass (asserted properly
    // in the gm_tools-only pass below; here we just confirm the two gates
    // are independent by not touching it).

    ;[...kickButtons, ...banButtons,
      screen.getByRole('button', { name: /^Access Level\b/ }),
      screen.getByRole('button', { name: 'Voice Ban' }),
      screen.getByRole('button', { name: 'SteamID Ban' }),
      screen.getByRole('button', { name: 'Add User' }),
      screen.getByRole('button', { name: 'Unban' }),
      screen.getByRole('button', { name: 'Unban SteamID' }),
    ].forEach(b => fireEvent.click(b))

    expect(kick).not.toHaveBeenCalled()
    expect(ban).not.toHaveBeenCalled()
    expect(setAccessLevel).not.toHaveBeenCalled()
    expect(voiceBan).not.toHaveBeenCalled()
    expect(banSteamId).not.toHaveBeenCalled()
    expect(addUser).not.toHaveBeenCalled()
    expect(unban).not.toHaveBeenCalled()
    expect(unbanSteamId).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Banned/ }))
    await waitFor(() => expect(screen.getByText('76561198000000002')).toBeInTheDocument(), { timeout: 3000 })
    const bannedRowUnban = screen.getAllByRole('button', { name: 'Unban' }).find(b => b.title?.includes('76561198000000002'))
    expect(bannedRowUnban).toBeDisabled()
    if (bannedRowUnban) fireEvent.click(bannedRowUnban)
    expect(unbanSteamId).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Whitelist/ }))
    await waitFor(() => expect(screen.getByPlaceholderText('76561198XXXXXXXXX')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.change(screen.getByPlaceholderText('76561198XXXXXXXXX'), { target: { value: '76561198000000099' } })
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addAllowedSteamId).not.toHaveBeenCalled()
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeButtons.length).toBeGreaterThanOrEqual(2)
    removeButtons.forEach(b => expect(b).toBeDisabled())
    removeButtons.forEach(b => fireEvent.click(b))
    expect(removeAllowedSteamId).not.toHaveBeenCalled()
    expect(removeFromWhitelist).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Spawn' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: /Give XP/ })).toBeInTheDocument(), { timeout: 3000 })
    const giveItemButton = screen.getByText('Give items').closest('button')
    const spawnVehicleButton = screen.getByText('Spawn vehicles').closest('button')
    expect(giveItemButton).toBeDisabled()
    expect(spawnVehicleButton).toBeDisabled()
    if (giveItemButton) fireEvent.click(giveItemButton)
    if (spawnVehicleButton) fireEvent.click(spawnVehicleButton)
    expect(addItem).not.toHaveBeenCalled()
    expect(addVehicle).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    const enableButtons = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableButtons).toHaveLength(3)
    enableButtons.forEach(b => expect(b).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).toBeDisabled()
    enableButtons.forEach(b => fireEvent.click(b))
    fireEvent.click(screen.getByRole('button', { name: 'Heal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    expect(sendCommand).not.toHaveBeenCalled()
    expect(screen.queryByText('Kill player')).not.toBeInTheDocument()
    expect(killPlayer).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Notes/ }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Note' })).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByRole('button', { name: 'Save Note' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save Note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(saveNote).not.toHaveBeenCalled()
    expect(deleteNote).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Moderation' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Teleport\b/ })).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByRole('button', { name: /^Teleport\b/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Teleport\b/ }))
    expect(teleport).not.toHaveBeenCalled()
  })

  it('dims Kick/Ban/Access Level ActionTiles (not just blocks the click) when a player is selected but the role lacks players.moderate', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    const kickTile = screen.getAllByRole('button', { name: /^Kick\b/ })[1].firstElementChild
    const banTile = screen.getAllByRole('button', { name: /^Ban\b/ })[1].firstElementChild
    const accessLevelTile = screen.getByRole('button', { name: /^Access Level\b/ }).firstElementChild
    expect(kickTile?.className).toContain('opacity-50')
    expect(banTile?.className).toContain('opacity-50')
    expect(accessLevelTile?.className).toContain('opacity-50')
  })

  it('enables gated triggers once the role holds the matching capability', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    screen.getAllByRole('button', { name: /^Kick\b/ }).forEach(b => expect(b).not.toBeDisabled())
    screen.getAllByRole('button', { name: /^Ban\b/ }).forEach(b => expect(b).not.toBeDisabled())
    expect(screen.getByRole('button', { name: /^Access Level\b/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /^Teleport\b/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Voice Ban' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'SteamID Ban' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add User' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unban' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unban SteamID' })).not.toBeDisabled()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    screen.getAllByRole('button', { name: 'Enable' }).forEach(b => expect(b).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).not.toBeDisabled()
  })

  it('bridge.command alone is not sufficient for the GM-tools four -- players.gm_tools is still required', async () => {
    mockCan = (capability) => capability === 'bridge.command'
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    const enableButtons = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableButtons).toHaveLength(3)
    enableButtons.forEach(b => expect(b).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).toBeDisabled()
    enableButtons.forEach(b => fireEvent.click(b))
    fireEvent.click(screen.getByRole('button', { name: 'Heal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    expect(sendCommand).not.toHaveBeenCalled()
    expect(killPlayer).not.toHaveBeenCalled()
  })

  it('players.gm_tools alone is sufficient for the GM-tools four, without bridge.command (Technician regains all four)', async () => {
    mockCan = (capability) => capability === 'players.gm_tools'
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    const enableButtons = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableButtons).toHaveLength(3)
    enableButtons.forEach(b => expect(b).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).not.toBeDisabled()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Moderation' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Teleport\b/ })).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByRole('button', { name: /^Teleport\b/ })).not.toBeDisabled()
  })

  it('the dossier "..." menu\'s six gated items never call their API when clicked, even though Radix runs onClick regardless of disabled', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    await openMoreActionsMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable God Mode' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable Invisible' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable Noclip' }))
    expect(sendCommand).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Whitelist' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Whitelist' }))
    expect(removeFromWhitelist).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Import/Export Character' }))
    expect(screen.queryByText('Export Character')).not.toBeInTheDocument()
  })
})
