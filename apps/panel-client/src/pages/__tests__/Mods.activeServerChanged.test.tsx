import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from '@/test/router'
import { SocketContext } from '@/contexts/SocketContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'

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
      listDiskOnly: vi.fn(),
      saveModOrder: vi.fn(),
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
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const saveModOrder = vi.mocked(modsApi.saveModOrder)

const socketHandlers = new Map<string, () => void>()
const fakeSocket = {
  on: (event: string, handler: () => void) => { socketHandlers.set(event, handler) },
  off: (event: string, handler: () => void) => {
    if (socketHandlers.get(event) === handler) socketHandlers.delete(event)
  },
} as never

function primeReadMocks() {
  getTrackedMods.mockResolvedValue({ mods: [] } as never)
  getStatus.mockResolvedValue({ totalModsTracked: 2, workshopAcfConfigured: false } as never)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: ['modA', 'modB'],
    workshopIds: [],
    maps: [],
    totalMods: 2,
  } as never)
  getIgnoredMods.mockResolvedValue([] as never)
  getIgnoredModPairs.mockResolvedValue([] as never)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  getPresets.mockResolvedValue([] as never)
  getCachedConflicts.mockResolvedValue(null as never)
  listDiskOnly.mockResolvedValue({ mods: [] } as never)
}

function renderMods() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={fakeSocket}>
        <TooltipProvider>
          <ConfirmProvider>
            <Mods />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Mods: active server changes during load-order editing', () => {
  it('blocks Save Order instead of writing the old order to the new server', async () => {
    primeReadMocks()
    renderMods()
    await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())

    fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
    fireEvent.click((await screen.findAllByRole('button', { name: /move down/i }))[0])

    const saveButton = await screen.findByRole('button', { name: /save order/i })
    expect(saveButton).not.toBeDisabled()

    act(() => { socketHandlers.get('activeServerChanged')?.() })

    await waitFor(() => expect(screen.getByRole('button', { name: /save order/i })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /save order/i }))
    expect(saveModOrder).not.toHaveBeenCalled()
  })

  it('reloads when the active server changes without an unsaved reorder', async () => {
    primeReadMocks()
    renderMods()
    await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
    getCurrentConfig.mockClear()

    act(() => { socketHandlers.get('activeServerChanged')?.() })

    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalledTimes(1))
  })
})
