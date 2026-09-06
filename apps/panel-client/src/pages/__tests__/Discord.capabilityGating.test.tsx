import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'


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
      start: vi.fn(),
      stop: vi.fn(),
      testToken: vi.fn(),
      sendTestMessage: vi.fn(),
      resetConfig: vi.fn(),
      updateConfig: vi.fn(),
      updateWebhookEvents: vi.fn(),
      updatePermissions: vi.fn(),
    },
  }
})

const getStatus = vi.mocked(discordApi.getStatus)
const getConfig = vi.mocked(discordApi.getConfig)
const getWebhookEvents = vi.mocked(discordApi.getWebhookEvents)
const getPermissions = vi.mocked(discordApi.getPermissions)
const stop = vi.mocked(discordApi.stop)
const testToken = vi.mocked(discordApi.testToken)
const sendTestMessage = vi.mocked(discordApi.sendTestMessage)
const resetConfig = vi.mocked(discordApi.resetConfig)
const updateConfig = vi.mocked(discordApi.updateConfig)
const updateWebhookEvents = vi.mocked(discordApi.updateWebhookEvents)
const updatePermissions = vi.mocked(discordApi.updatePermissions)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDiscord() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Discord />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

async function setUpConfiguredRunningBot() {
  getStatus.mockResolvedValue({ running: true, configured: true })
  getConfig.mockResolvedValue({
    token: null,
    hasToken: true,
    guildId: '123456789012345678',
    adminRoleId: '',
    modRoleId: '',
    channelId: '234567890123456789',
    autoStart: true,
    chatRelayEnabled: true,
    chatRelayChannelId: '',
    chatRelayScope: 'public',
  })
  getWebhookEvents.mockResolvedValue({ events: {} })
  getPermissions.mockResolvedValue({ permissions: {} })
}

describe('Discord.tsx: every mutating control gates on integrations.manage', () => {
  it('disables every action and never reaches the API when the role lacks integrations.manage', async () => {
    mockCan = () => false
    await setUpConfiguredRunningBot()

    renderDiscord()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText(/Bot Token/), { target: { value: 'fake-token-value' } })

    const buttonNames = ['Stop Bot', 'Send Test', 'Verify Token', 'Wipe Discord Setup', 'Save Changes', 'Save Events', 'Save Permissions']
    const buttons = buttonNames.map((name) => screen.getByRole('button', { name }))
    for (const button of buttons) {
      expect(button).toBeDisabled()
    }

    for (const button of buttons) {
      fireEvent.click(button)
    }

    expect(stop).not.toHaveBeenCalled()
    expect(sendTestMessage).not.toHaveBeenCalled()
    expect(testToken).not.toHaveBeenCalled()
    expect(resetConfig).not.toHaveBeenCalled()
    expect(updateConfig).not.toHaveBeenCalled()
    expect(updateWebhookEvents).not.toHaveBeenCalled()
    expect(updatePermissions).not.toHaveBeenCalled()
  })

  it('enables every action when the role holds integrations.manage', async () => {
    mockCan = () => true
    await setUpConfiguredRunningBot()

    renderDiscord()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeInTheDocument())

    const buttonNames = ['Stop Bot', 'Send Test', 'Wipe Discord Setup', 'Save Events', 'Save Permissions']
    for (const name of buttonNames) {
      expect(screen.getByRole('button', { name })).not.toBeDisabled()
    }
    // Verify Token / Save Changes stay disabled here for reasons unrelated
    // to capability (no token typed yet / canSaveConfig's own validation) --
    // covered by their own existing tests, not this file's concern.
  })
})
