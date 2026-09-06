import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, mapApi, ApiError } from '@/lib/api'


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
    mapApi: { ...actual.mapApi, resolve: vi.fn() },
    chunksApi: {
      ...actual.chunksApi,
      getSaves: vi.fn(),
      suggestedPaths: vi.fn(),
      getChunks: vi.fn(),
      getStats: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const mapResolve = vi.mocked(mapApi.resolve)
const getSaves = vi.mocked(chunksApi.getSaves)
const suggestedPaths = vi.mocked(chunksApi.suggestedPaths)
const getChunks = vi.mocked(chunksApi.getChunks)
const getStats = vi.mocked(chunksApi.getStats)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

function renderChunkCleaner() {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  getResolvedActive.mockResolvedValue({ server: null })
  suggestedPaths.mockResolvedValue({ candidates: [] })
  mapResolve.mockResolvedValue({
    root: '/tiles', b42Dir: 'test-build', b41Path: '/tiles/b41',
    tileSize: 1024, width: 1, height: 1, maxLevel: 1, renderedMaxLevel: 1,
  })
  return render(<ChunkCleaner />)
}

describe('ChunkCleaner.tsx: read routes gated behind chunks.manage (41fa20a3 follow-up)', () => {
  it('shows a dedicated permission-denied state on a real 403 from fetchSaves, not the misleading "no saves found" panel', async () => {
    getSaves.mockRejectedValue(new ApiError('Forbidden', { status: 403 }))
    renderChunkCleaner()

    expect(await screen.findByText(/you can't view map cleanup/i)).toBeInTheDocument()

    expect(screen.queryByText(/no saves found/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  })

  it('shows the Access Denied eyebrow on the real permission-denied render, not the No Data default', async () => {
    getSaves.mockRejectedValue(new ApiError('Forbidden', { status: 403 }))
    renderChunkCleaner()

    await screen.findByText(/you can't view map cleanup/i)
    expect(screen.getByText('Access Denied')).toBeInTheDocument()
    expect(screen.queryByText('No Data')).not.toBeInTheDocument()
  })

  it('does not fire the destructive load-failed toast on a 403 -- the denied state IS the answer, not an error to also announce', async () => {
    getSaves.mockRejectedValue(new ApiError('Forbidden', { status: 403 }))
    renderChunkCleaner()

    await screen.findByText(/you can't view map cleanup/i)
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('does not fall back to suggestedPaths on a 403 -- that route is gated by the exact same capability and would just 403 again pointlessly', async () => {
    getSaves.mockRejectedValue(new ApiError('Forbidden', { status: 403 }))
    renderChunkCleaner()

    await screen.findByText(/you can't view map cleanup/i)
    expect(suggestedPaths).not.toHaveBeenCalled()
  })

  it('never reaches getChunks/getStats when getSaves 403s -- loadChunks cannot run without a selected save, and none gets selected', async () => {
    getSaves.mockRejectedValue(new ApiError('Forbidden', { status: 403 }))
    renderChunkCleaner()

    await screen.findByText(/you can't view map cleanup/i)
    expect(getChunks).not.toHaveBeenCalled()
    expect(getStats).not.toHaveBeenCalled()
  })

  it('a non-403 failure (real server/data problem) still shows the ORIGINAL empty state and toast, unaffected by this fix', async () => {
    getSaves.mockRejectedValue(new ApiError('Internal error', { status: 500 }))
    renderChunkCleaner()

    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(screen.queryByText(/you can't view map cleanup/i)).not.toBeInTheDocument()
  })

  it('a successful load with saves present renders normally regardless of canManageChunks (read access already proven by the 200)', async () => {
    mockCan = () => false
    getSaves.mockResolvedValue({
      saves: [{ name: 'Ashenwood', modified: '2026-08-20T00:00:00.000Z', chunkCount: 1, size: 1024, sizeFormatted: '1.0 KB' }],
      debug: null,
    })
    getChunks.mockResolvedValue({ chunks: [], bounds: null, isB42: false })
    getStats.mockResolvedValue({ saveName: 'Ashenwood', totalSize: 0, totalSizeFormatted: '0 B', folders: {} })
    renderChunkCleaner()

    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(screen.queryByText(/you can't view map cleanup/i)).not.toBeInTheDocument()
  })
})
