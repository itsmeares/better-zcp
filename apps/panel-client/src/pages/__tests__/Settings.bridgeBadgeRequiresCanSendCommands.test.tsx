import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from '@/test/router'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn().mockResolvedValue({ settings: {} }) },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn().mockResolvedValue({
        configured: true,
        bridgePath: '/some/bridge/path',
        isRunning: true,
        pendingCommands: 0,
        modConnected: true,
        consecutiveFailures: 2,
        modStatus: {
          alive: true,
          version: '1.0.0',
          serverName: 'Test Server',
          playerCount: 3,
          players: ['a', 'b', 'c'],
          path: '/some/path',
          timestamp: Date.now(),
        },
        connection: {
          healthy: false,
          canSendCommands: false,
          summary: 'Status file is stale (12s old) — is the PZ server running?',
          issues: ['Status file is stale (12s old) — is the PZ server running?'],
          checks: { bridgePathExists: true, bridgePathWritable: true, statusFilePresent: true, statusFresh: false },
        },
      }),
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

describe('Settings -> Bridge tab: badge and Ping button when modConnected but !canSendCommands', () => {
  it('does not show "Bridge connected" and disables Ping when the mod is alive but the panel cannot currently send commands', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=bridge']}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Ping Mod' })).toBeInTheDocument())

    expect(screen.queryByText('Bridge connected')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ping Mod' })).toBeDisabled()
  })
})
