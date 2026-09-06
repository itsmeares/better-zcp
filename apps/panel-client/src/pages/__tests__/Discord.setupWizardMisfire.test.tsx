import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'

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
    discordApi: {
      ...actual.discordApi,
      getStatus: vi.fn(),
      getConfig: vi.fn(),
      getWebhookEvents: vi.fn(),
      getPermissions: vi.fn(),
    },
  }
})

const getStatus = vi.mocked(discordApi.getStatus)
const getConfig = vi.mocked(discordApi.getConfig)
const getWebhookEvents = vi.mocked(discordApi.getWebhookEvents)
const getPermissions = vi.mocked(discordApi.getPermissions)

function renderDiscord() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Discord />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

beforeEach(() => {
  getStatus.mockReset()
  getConfig.mockReset()
  getWebhookEvents.mockReset().mockResolvedValue({ events: {} })
  getPermissions.mockReset().mockResolvedValue({ permissions: {} })
})

describe('Discord -- a failed config read must not present the setup wizard', () => {
  it('shows the management dashboard, not the setup wizard, when config fails to load on a stopped-but-configured bot', async () => {
    getConfig.mockRejectedValue(new Error('network error'))
    getStatus.mockResolvedValue({ running: false, configured: true })

    renderDiscord()

    expect(await screen.findByText('Discord Bot')).toBeInTheDocument()
    expect(screen.queryByText('Discord Bot Setup')).not.toBeInTheDocument()
  })

  it('still shows the setup wizard for a genuinely unconfigured bot when nothing failed to load', async () => {
    getConfig.mockResolvedValue(null)
    getStatus.mockResolvedValue({ running: false, configured: false })

    renderDiscord()

    expect(await screen.findByText('Discord Bot Setup')).toBeInTheDocument()
    expect(screen.queryByText('Discord Bot', { selector: 'h1' })).not.toBeInTheDocument()
  })
})
