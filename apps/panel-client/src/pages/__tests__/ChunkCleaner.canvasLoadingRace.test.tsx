import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, mapApi } from '@/lib/api'


vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
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

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

describe('ChunkCleaner.tsx: canvas must not claim "no saves found" before fetchSaves() has settled', () => {
  it('shows a loading indicator, not the no-saves empty state, while getSaves is still in flight', async () => {
    getSaves.mockImplementation(() => new Promise(() => {}))
    renderChunkCleaner()

    expect((await screen.findAllByText(/loading saves/i)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/no saves found/i)).not.toBeInTheDocument()
  })

  it('shows the no-saves empty state, not a loading indicator, once getSaves resolves to a genuinely empty list', async () => {
    getSaves.mockResolvedValue({ saves: [], debug: null })
    renderChunkCleaner()

    expect(await screen.findByText(/no saves found/i)).toBeInTheDocument()
    expect(screen.queryByText(/loading saves/i)).not.toBeInTheDocument()
  })

  it('never renders "no saves found" once getSaves resolves with saves present', async () => {
    getSaves.mockResolvedValue({
      saves: [{ name: 'Ashenwood', modified: '2026-08-20T00:00:00.000Z', chunkCount: 1, size: 1024, sizeFormatted: '1.0 KB' }],
      debug: null,
    })
    renderChunkCleaner()

    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(screen.queryByText(/no saves found/i)).not.toBeInTheDocument()
  })
})
