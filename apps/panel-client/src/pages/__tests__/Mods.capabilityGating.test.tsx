import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serversApi, ApiError } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'


let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
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
    modsApi: {
      ...actual.modsApi,
      getTrackedMods: vi.fn(),
      getStatus: vi.fn(),
      getCurrentConfig: vi.fn(),
      getIgnoredMods: vi.fn(),
      getIgnoredModPairs: vi.fn(),
      collectionDiff: vi.fn(),
      getPresets: vi.fn(),
      getCachedConflicts: vi.fn(),
      enableDiskMod: vi.fn(),
      deleteDiskMod: vi.fn(),
      listDiskOnly: vi.fn(),
      createPreset: vi.fn(),
      applyPreset: vi.fn(),
      deletePreset: vi.fn(),
      saveModOrder: vi.fn(),
      checkUpdates: vi.fn(),
      syncFromServer: vi.fn(),
      batchRemove: vi.fn(),
    },
    serversApi: {
      ...actual.serversApi,
      getActive: vi.fn(),
      update: vi.fn(),
    },
  }
})

const getTrackedMods = vi.mocked(modsApi.getTrackedMods)
const getStatus = vi.mocked(modsApi.getStatus)
const getCurrentConfig = vi.mocked(modsApi.getCurrentConfig)
const getIgnoredMods = vi.mocked(modsApi.getIgnoredMods)
const getIgnoredModPairs = vi.mocked(modsApi.getIgnoredModPairs)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const getPresets = vi.mocked(modsApi.getPresets)
const getCachedConflicts = vi.mocked(modsApi.getCachedConflicts)
const enableDiskMod = vi.mocked(modsApi.enableDiskMod)
const deleteDiskMod = vi.mocked(modsApi.deleteDiskMod)
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const createPreset = vi.mocked(modsApi.createPreset)
const saveModOrder = vi.mocked(modsApi.saveModOrder)
const checkUpdates = vi.mocked(modsApi.checkUpdates)
const syncFromServer = vi.mocked(modsApi.syncFromServer)
const getActive = vi.mocked(serversApi.getActive)
const serversUpdate = vi.mocked(serversApi.update)

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>
  )
}

function renderModsWithConfirm() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Mods />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
}

async function waitForLoaded() {
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
}

async function openMoreActionsMenu() {
  const trigger = await screen.findByRole('button', { name: /more actions/i })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

function primeReadMocks() {
  getTrackedMods.mockResolvedValue({ mods: [] } as any)
  getStatus.mockResolvedValue({
    totalModsTracked: 1,
    workshopAcfConfigured: false,
    autoRestartEnabled: false,
  } as any)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: [],
    workshopIds: [],
    maps: [],
    totalMods: 0,
  } as any)
  getIgnoredMods.mockResolvedValue([] as any)
  getIgnoredModPairs.mockResolvedValue([] as any)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as any)
  getPresets.mockResolvedValue([] as any)
  getCachedConflicts.mockResolvedValue(null as any)
  listDiskOnly.mockResolvedValue({ mods: [] } as any)
  getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as any)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

describe('Mods.tsx capability gating -- mods.manage', () => {
  it('disables "Check for Updates" and never calls checkUpdates when mods.manage is denied', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const buttons = await screen.findAllByRole('button', { name: /check updates/i })
    for (const btn of buttons) {
      expect(btn).toBeDisabled()
      fireEvent.click(btn)
    }
    await new Promise((r) => setTimeout(r, 0))
    expect(checkUpdates).not.toHaveBeenCalled()
  })

  it('calls checkUpdates when mods.manage is granted', async () => {
    mockCan = () => true
    primeReadMocks()
    checkUpdates.mockResolvedValue({ mods: [], updatesFound: 0 } as any)
    renderMods()
    await waitForLoaded()

    const [btn] = await screen.findAllByRole('button', { name: /check updates/i })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    await waitFor(() => expect(checkUpdates).toHaveBeenCalled())
  })

  it('disables "Sync from Server" and never calls syncFromServer when mods.manage is denied', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const [btn] = await screen.findAllByRole('button', { name: /sync from server/i })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    await new Promise((r) => setTimeout(r, 0))
    expect(syncFromServer).not.toHaveBeenCalled()
  })

  it('gates disk-mod enable/delete: guard inside the handler blocks the call even if the click event still fires', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    listDiskOnly.mockResolvedValue({ mods: [{ workshop_id: '123', name: 'Test Mod' }] } as any)
    renderMods()
    await waitForLoaded()

    expect(enableDiskMod).not.toHaveBeenCalled()
    expect(deleteDiskMod).not.toHaveBeenCalled()
  })

  it('gates preset creation: Save Preset stays disabled and createPreset is never called without mods.manage', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const presetsNavButtons = screen.queryAllByText(/presets/i)
    if (presetsNavButtons.length > 0) {
      fireEvent.click(presetsNavButtons[0])
    }
    await new Promise((r) => setTimeout(r, 0))
    expect(createPreset).not.toHaveBeenCalled()
  })
})

describe('Mods.tsx capability gating -- "More actions" dropdown menu items', () => {
  it('disables the menu items and never opens their dialogs when mods.manage is denied', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const menu = await openMoreActionsMenu()
    const importItem = await screen.findByRole('menuitem', { name: /import collection/i })
    const restartItem = await screen.findByRole('menuitem', { name: /auto-restart settings/i })
    expect(importItem).toHaveAttribute('aria-disabled', 'true')
    expect(restartItem).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(importItem)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(restartItem)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    void menu
  })

  it('opens the Import Collection dialog when mods.manage is granted', async () => {
    mockCan = () => true
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    await openMoreActionsMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /import collection/i }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })

  it('opens the Auto-Restart Settings dialog when mods.manage is granted', async () => {
    mockCan = () => true
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    await openMoreActionsMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /auto-restart settings/i }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })
})

describe('Mods.tsx capability gating -- servers.manage (Fix Path outlier)', () => {
  it('disables "Fix Path" and never calls serversApi.update when servers.manage is denied, even though mods.manage is granted', async () => {
    mockCan = (cap) => cap !== 'servers.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const fixPathBtn = await screen.findByRole('button', { name: /fix path/i })
    expect(fixPathBtn).toBeDisabled()
    fireEvent.click(fixPathBtn)
    await new Promise((r) => setTimeout(r, 0))
    expect(serversUpdate).not.toHaveBeenCalled()
  })

  it('leaves "Fix Path" enabled when servers.manage is granted, independent of mods.manage', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const fixPathBtn = await screen.findByRole('button', { name: /fix path/i })
    expect(fixPathBtn).not.toBeDisabled()
  })
})

describe('Mods.tsx: a real 403 on every mount-time fetch shows a permission-denied empty state, not a false "backend unreachable" message', () => {
  it('shows the empty state, not the misleading fetch-error banner, when every mount-time call is refused with a real 403', async () => {
    mockCan = () => true
    const denied = () => Promise.reject(new ApiError('Forbidden', { status: 403 }))
    getTrackedMods.mockImplementation(denied)
    getStatus.mockImplementation(denied)
    getCurrentConfig.mockImplementation(denied)
    getIgnoredMods.mockImplementation(denied)
    getIgnoredModPairs.mockImplementation(denied)
    getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as any)

    renderMods()
    await waitForLoaded()

    await waitFor(() => expect(screen.getByText("You can't view mods")).toBeInTheDocument())
    expect(screen.queryByText(/backend may be unreachable/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Mod management sections')).not.toBeInTheDocument()
  })

  it('shows the normal page, not the empty state, when the failures are a genuine mixed/transient error (not all-403)', async () => {
    mockCan = () => true
    getTrackedMods.mockRejectedValue(new Error('network blip'))
    primeReadMocks()
    getTrackedMods.mockRejectedValue(new Error('network blip'))

    renderMods()
    await waitForLoaded()

    await waitFor(() => expect(screen.queryByText(/temporarily unavailable/i)).toBeInTheDocument())
    expect(screen.queryByText("You can't view mods")).not.toBeInTheDocument()
  })
})

describe('Mods.tsx: Deactivated tab "Delete All" tracking-cleanup gates on mods.manage', () => {
  async function primeDeactivatedFixture() {
    getTrackedMods.mockResolvedValue({ mods: [{ workshop_id: '999', name: 'Deactivated Mod', last_checked: '2026-01-01' }] } as any)
    getStatus.mockResolvedValue({ totalModsTracked: 1, workshopAcfConfigured: true, autoRestartEnabled: false } as any)
    getCurrentConfig.mockResolvedValue({ configured: true, modIds: [], workshopIds: [], maps: [], totalMods: 0 } as any)
    getIgnoredMods.mockResolvedValue([] as any)
    getIgnoredModPairs.mockResolvedValue([] as any)
    collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as any)
    getPresets.mockResolvedValue([] as any)
    getCachedConflicts.mockResolvedValue(null as any)
    listDiskOnly.mockResolvedValue({ mods: [] } as any)
    getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as any)
  }

  async function openDeactivatedTrackingCleanup() {
    fireEvent.click(await screen.findByRole('button', { name: /deactivated/i }))
    fireEvent.click(await screen.findByText('Tracking cleanup'))
    return screen.findByRole('button', { name: /delete all/i })
  }

  it('disables "Delete All" and never calls batchRemove when mods.manage is denied', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    await primeDeactivatedFixture()
    renderMods()
    await waitForLoaded()

    const deleteAllBtn = await openDeactivatedTrackingCleanup()
    expect(deleteAllBtn).toBeDisabled()
    fireEvent.click(deleteAllBtn)
    await new Promise((r) => setTimeout(r, 0))

    const batchRemove = vi.mocked(modsApi.batchRemove)
    expect(batchRemove).not.toHaveBeenCalled()
  })

  it('reaches batchRemove when mods.manage is granted (click through the real confirm dialog)', async () => {
    mockCan = () => true
    await primeDeactivatedFixture()
    const batchRemove = vi.mocked(modsApi.batchRemove)
    batchRemove.mockResolvedValue({ success: true, total: 1, dbRemoved: 1, dbFailed: 0, iniRemoved: 1 } as any)
    renderModsWithConfirm()
    await waitForLoaded()

    const deleteAllBtn = await openDeactivatedTrackingCleanup()
    expect(deleteAllBtn).not.toBeDisabled()
    fireEvent.click(deleteAllBtn)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(batchRemove).toHaveBeenCalledWith(['999']))
  })
})
