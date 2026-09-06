import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, mapApi } from '@/lib/api'

// 2026-08-30 visual sweep, 4th instance of one idiom (see 3665aa20, da9bb687,
// a83c425a): a value that starts out looking like "confirmed empty" when it
// really means "haven't checked yet". loadingSaves started false, and the
// canvas's own condition never consulted it at all -- so from the very
// first frame, and for the fetch's ENTIRE duration (not just a one-frame
// flicker), the canvas rendered "No saves found -- here's what we tried" as
// an investigated fact, while the Save Selection dropdown two feet away
// correctly showed "Loading saves...". The dropdown was never the bug.

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
    getSaves.mockImplementation(() => new Promise(() => {})) // never resolves within this test
    renderChunkCleaner()

    // Present in both the dropdown placeholder and the canvas now -- assert
    // presence, not uniqueness, of the loading text.
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
