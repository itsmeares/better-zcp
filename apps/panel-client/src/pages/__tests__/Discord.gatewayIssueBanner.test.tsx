import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

const BASE_CONFIG = {
  token: null,
  hasToken: true,
  guildId: '111111111111111111',
  adminRoleId: '',
  modRoleId: '',
  channelId: '222222222222222222',
  autoStart: true,
  chatRelayEnabled: true,
  chatRelayChannelId: '',
  chatRelayScope: 'public' as const,
}

function renderDiscord() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Discord />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

const BANNER_TEXT =
  /Discord connection has been unstable/i

beforeEach(() => {
  getStatus.mockReset()
  getConfig.mockReset().mockResolvedValue(BASE_CONFIG)
  getWebhookEvents.mockReset().mockResolvedValue({ events: {} })
  getPermissions.mockReset().mockResolvedValue({ permissions: {} })
  localStorage.clear()
})

describe('Discord -- gateway-issue banner', () => {
  it('does not render when the bot is healthy (gatewayIssue false)', async () => {
    getStatus.mockResolvedValue({
      running: true,
      configured: true,
      gatewayIssue: false,
      gatewayDegradedSince: null,
    })

    renderDiscord()

    expect(await screen.findByText('Discord Bot')).toBeInTheDocument()
    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument()
  })

  it('renders when gatewayIssue is true, and dismissing it hides it', async () => {
    getStatus.mockResolvedValue({
      running: true,
      configured: true,
      gatewayIssue: true,
      gatewayDegradedSince: '2026-08-29T19:00:00.000Z',
    })

    renderDiscord()

    expect(await screen.findByText(BANNER_TEXT)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /dismiss connection warning/i }))

    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument()
    expect(localStorage.getItem('pz-discord-gateway-issue-dismissed')).toBe(
      '2026-08-29T19:00:00.000Z',
    )
  })

  it('a dismissed episode stays hidden across a fresh mount (persisted, not just component state)', async () => {
    localStorage.setItem(
      'pz-discord-gateway-issue-dismissed',
      '2026-08-29T19:00:00.000Z',
    )
    getStatus.mockResolvedValue({
      running: true,
      configured: true,
      gatewayIssue: true,
      gatewayDegradedSince: '2026-08-29T19:00:00.000Z',
    })

    renderDiscord()

    expect(await screen.findByText('Discord Bot')).toBeInTheDocument()
    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument()
  })

  it('a NEW degraded episode (different gatewayDegradedSince) re-surfaces even though an earlier one was dismissed', async () => {
    localStorage.setItem(
      'pz-discord-gateway-issue-dismissed',
      '2026-08-29T19:00:00.000Z', // an OLDER episode, already dismissed
    )
    getStatus.mockResolvedValue({
      running: true,
      configured: true,
      gatewayIssue: true,
      gatewayDegradedSince: '2026-08-29T20:15:00.000Z', // a NEW, different episode
    })

    renderDiscord()

    expect(await screen.findByText(BANNER_TEXT)).toBeInTheDocument()
  })
})
