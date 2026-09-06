import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, panelBridgeApi, mapApi } from '@/lib/api'


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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    chunksApi: {
      ...actual.chunksApi,
      getSaves: vi.fn(),
      getChunks: vi.fn(),
      getStats: vi.fn(),
      deleteChunks: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      sendCommand: vi.fn(),
    },
    mapApi: { ...actual.mapApi, resolve: vi.fn() },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getSaves = vi.mocked(chunksApi.getSaves)
const getChunks = vi.mocked(chunksApi.getChunks)
const getStats = vi.mocked(chunksApi.getStats)
const deleteChunks = vi.mocked(chunksApi.deleteChunks)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)
const resolveMap = vi.mocked(mapApi.resolve)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const testSave = {
  name: 'Ashenwood',
  modified: '2026-08-20T00:00:00.000Z',
  chunkCount: 2,
  size: 2048,
  sizeFormatted: '2.0 KB',
}

const chunkA = { file: 'chunk_0_0.bin', x: 0, y: 0, size: 1024, modified: '2026-08-20T00:00:00.000Z' }
const chunkB = { file: 'chunk_10_0.bin', x: 10, y: 0, size: 1024, modified: '2026-08-20T00:00:00.000Z' }

const testStats = {
  saveName: 'Ashenwood',
  totalSize: 2048,
  totalSizeFormatted: '2.0 KB',
  folders: {},
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderChunkCleaner() {
  return render(<ChunkCleaner />)
}

function setUp() {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  resolveMap.mockRejectedValue(new Error('not needed for this test'))
  getResolvedActive.mockResolvedValue({ server: null })
  getSaves.mockResolvedValue({ saves: [testSave], debug: null })
  getChunks.mockResolvedValue({ chunks: [chunkA, chunkB], bounds: { minX: 0, maxX: 10, minY: 0, maxY: 0 }, isB42: false })
  getStats.mockResolvedValue(testStats)
  deleteChunks.mockResolvedValue({ deleted: 2, vehiclesDeleted: 0, errors: [] })
  sendCommand.mockImplementation((action: string) => {
    if (action === 'getVehiclesDetailed') return Promise.resolve({ success: true, data: { vehicles: [] } })
    if (action === 'getSafehouses') return Promise.resolve({ success: true, data: { safehouses: [] } })
    if (action === 'removeVehiclesInArea') return Promise.resolve({ success: true, data: {} })
    return Promise.resolve({ success: true, data: {} })
  })
}

async function mountWithBothSelected() {
  renderChunkCleaner()
  const allButton = await screen.findByRole('button', { name: /^all$/i })
  await waitFor(() => expect(allButton).not.toBeDisabled())
  fireEvent.click(allButton)
}

describe('ChunkCleaner.tsx: live vehicle removal for a non-contiguous selection', () => {
  it('sends one removeVehiclesInArea call per selected chunk, never one box spanning the gap between them', async () => {
    mockCan = () => true
    setUp()
    await mountWithBothSelected()

    fireEvent.click(await screen.findByRole('button', { name: /delete 2 chunks/i }))
    fireEvent.click(await screen.findByRole('button', { name: /delete selected chunks/i }))

    await waitFor(() => expect(deleteChunks).toHaveBeenCalledTimes(1))

    const areaCalls = sendCommand.mock.calls.filter(([action]) => action === 'removeVehiclesInArea')

    const sweptTheGap = areaCalls.some(([, args]) => {
      const a = args as { minX: number; maxX: number }
      return a.minX === 0 && a.maxX === 110
    })
    expect(sweptTheGap).toBe(false)

    expect(areaCalls).toHaveLength(2)
    const boxes = areaCalls.map(([, args]) => args as { minX: number; minY: number; maxX: number; maxY: number })
    expect(boxes).toEqual(
      expect.arrayContaining([
        { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        { minX: 100, minY: 0, maxX: 110, maxY: 10 },
      ]),
    )
  })
})
