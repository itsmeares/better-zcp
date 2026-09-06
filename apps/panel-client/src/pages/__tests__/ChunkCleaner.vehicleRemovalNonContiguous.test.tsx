import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, panelBridgeApi, mapApi } from '@/lib/api'

// 2026-08-31 bug hunt: handleDelete's "remove already-loaded vehicles live"
// step (ChunkCleaner.tsx ~2004-2043) built ONE rectangular bounding box
// across every selected chunk's extent, not the actual selected-chunk set.
// For a non-contiguous selection (individual click-toggle, Select All,
// Invert Selection all produce these routinely) that box's UNION includes
// chunks the operator never selected and is NOT deleting -- PanelBridge.lua's
// handlers.removeVehiclesInArea takes only {minX,minY,maxX,maxY}, a genuine
// rectangular sweep with no chunk-list awareness, so live vehicles in every
// UNSELECTED chunk between the two selected ones get removed too.
//
// Fix: decompose the selection into the minimal set of rectangles whose
// UNION is exactly the selected chunks, and send one removeVehiclesInArea
// call per rectangle. This test selects two chunks in the same row with a
// gap between them (x=0 and x=10, nothing selected in between) and asserts
// the live-removal calls cover exactly those two 1-chunk boxes -- never a
// single box spanning the gap.

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
    // Mounts unconditionally (ChunkCleaner.tsx's b42DirRef effect) and, left
    // real, hits fetchWithRetry's actual backoff schedule against a
    // nonexistent server in jsdom -- harmless in isolation but slow enough
    // (multiple real retries) to occasionally blow past this test's own
    // waitFor/assertions. Reject it instantly instead.
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

// Same row (y=0), nine chunks apart -- nothing selected in x=1..9. A B41
// save (tilesPerChunk=10), so the OLD single-bounding-box bug would have
// swept live vehicles from game-tiles x=10..100, y=0..10 -- chunks 1-9,
// none of which are selected or being deleted.
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

    // The old single-bounding-box bug sent exactly one call spanning both
    // chunks' full extent (game-tiles x=0..110), sweeping the unselected
    // gap in between. The fix must never send that box.
    const sweptTheGap = areaCalls.some(([, args]) => {
      const a = args as { minX: number; maxX: number }
      return a.minX === 0 && a.maxX === 110
    })
    expect(sweptTheGap).toBe(false)

    // Exactly two calls, each covering only one chunk's own 10x10 tile
    // extent -- chunk (0,0) is tiles [0,10)x[0,10), chunk (10,0) is tiles
    // [100,110)x[0,10). Order isn't guaranteed, so match by set.
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
