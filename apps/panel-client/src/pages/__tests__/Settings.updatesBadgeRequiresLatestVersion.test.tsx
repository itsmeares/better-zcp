import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from '@/lib/routerCompat'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn().mockResolvedValue({ settings: {} }) },
    panelUpdateApi: {
      ...actual.panelUpdateApi,
      getStatus: vi.fn().mockResolvedValue({
        currentVersion: '1.2.9',
        updateAvailable: false,
        latestVersion: null,
        releaseUrl: null,
        releaseNotes: null,
        publishedAt: null,
        isChecking: false,
        isDownloading: false,
        downloadProgress: 0,
        lastCheck: null,
        lastError: null,
        stagedUpdate: null,
        lastApplyResult: null,
      }),
      preflight: vi.fn().mockResolvedValue({ ok: true, blockers: [], warnings: [] }),
    },
  }
})

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'admin', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

describe('Settings -> Updates tab: status badge requires an actual check, not just a non-null response', () => {
  it('shows "Not checked" rather than "Up to date" when the server has never checked', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=updates']}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Not checked')).toBeInTheDocument())
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument()
  })
})
