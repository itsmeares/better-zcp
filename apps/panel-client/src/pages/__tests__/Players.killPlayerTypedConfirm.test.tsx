import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// killplayer-ui-2026-08-30: killPlayer is permanent character loss in a
// permadeath game, inflicted on someone else -- the only destructive one of
// the five GM-tools Powers-tab actions. Guarded by a NEW, app-wide
// typed-confirmation field on ConfirmContext (ConfirmOptions.
// requireTypedConfirmation): the Confirm button in the dialog stays disabled
// until the admin types the TARGET PLAYER'S USERNAME, not just clicks
// through. This proves the gate itself, not just the happy path: the action
// must NOT be dispatched when the typed value doesn't match the target's
// username, and must NOT be dispatched at all when the bridge is down
// (Kill's own disabled state, same as its four Powers-tab siblings).

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
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const killPlayer = vi.mocked(panelBridgeApi.killPlayer)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Players />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUpFixtures(modConnected: boolean) {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayerAndOpenPowers() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Kill' })).toBeInTheDocument(), { timeout: 3000 })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Players.tsx: killPlayer is guarded by a typed username confirmation', () => {
  it('is NOT dispatched when the bridge is down -- the Kill button itself is disabled, the dialog never opens', async () => {
    await setUpFixtures(false)
    renderPlayers()
    await selectTestPlayerAndOpenPowers()

    expect(screen.getByRole('button', { name: 'Kill' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))

    expect(screen.queryByText('Kill player')).not.toBeInTheDocument()
    expect(killPlayer).not.toHaveBeenCalled()
  })

  it('is NOT dispatched when the typed value does not match the target player\'s username', async () => {
    await setUpFixtures(true)
    renderPlayers()
    await selectTestPlayerAndOpenPowers()

    expect(screen.getByRole('button', { name: 'Kill' })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))

    const confirmButton = await screen.findByRole('button', { name: 'Kill player' })
    // Nothing typed yet -- must start disabled, not default to armed.
    expect(confirmButton).toBeDisabled()

    const typedInput = screen.getByLabelText('Type TestPlayer to confirm')
    fireEvent.change(typedInput, { target: { value: 'NotTestPlayer' } })
    expect(confirmButton).toBeDisabled()
    fireEvent.click(confirmButton)

    expect(killPlayer).not.toHaveBeenCalled()

    // A trailing-space or wrong-case near-match must not slip through either
    // -- this is a barrier against clicking through blind, not a fuzzy hint.
    fireEvent.change(typedInput, { target: { value: 'testplayer' } })
    expect(confirmButton).toBeDisabled()
    fireEvent.change(typedInput, { target: { value: 'TestPlayer ' } })
    expect(confirmButton).toBeDisabled()
  })

  it('IS dispatched, with the target username, once the typed value matches exactly', async () => {
    killPlayer.mockResolvedValue({ success: true, data: { message: 'Player killed', username: 'TestPlayer', isDead: true, debug: '' } })
    await setUpFixtures(true)
    renderPlayers()
    await selectTestPlayerAndOpenPowers()

    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    const confirmButton = await screen.findByRole('button', { name: 'Kill player' })
    const typedInput = screen.getByLabelText('Type TestPlayer to confirm')

    fireEvent.change(typedInput, { target: { value: 'TestPlayer' } })
    expect(confirmButton).not.toBeDisabled()
    fireEvent.click(confirmButton)

    await waitFor(() => expect(killPlayer).toHaveBeenCalledWith('TestPlayer'))
  })

  // 2026-08-31 impeccable pass: ConfirmContext.tsx's requireTypedConfirmation
  // defaults an omitted `placeholder` to the exact required value -- an
  // untouched input would show "TestPlayer" in placeholder-gray, pixel-
  // indistinguishable at a glance from having already typed it (confirmed by
  // cropping the rendered screenshot and comparing text color against a real
  // button's text). handleKillPlayer now passes an explicit empty
  // placeholder so the box is genuinely blank instead.
  it('the typed-confirmation input has no placeholder text mirroring the required value', async () => {
    await setUpFixtures(true)
    renderPlayers()
    await selectTestPlayerAndOpenPowers()

    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    const typedInput = await screen.findByLabelText('Type TestPlayer to confirm')

    expect(typedInput).toHaveAttribute('placeholder', '')
    expect(typedInput).toHaveValue('')
  })
})
