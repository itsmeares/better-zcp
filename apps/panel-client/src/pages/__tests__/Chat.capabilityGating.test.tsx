import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Chat from '../Chat'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

vi.mock('@/components/ui/select', () => {
  function findAriaLabel(children: React.ReactNode): string | undefined {
    let found: string | undefined
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const label = (child.props as { 'aria-label'?: string })['aria-label']
      if (label) found = label
    })
    return found
  }
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, disabled, children }: { value: string; onValueChange: (v: string) => void; disabled?: boolean; children: React.ReactNode }) {
    return (
      <select
        aria-label={findAriaLabel(children)}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {collectItems(children).map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

Element.prototype.scrollIntoView = vi.fn()

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
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      sendToServerChat: vi.fn(),
      sendToAdminChat: vi.fn(),
      sendToGeneralChat: vi.fn(),
      getChatInfo: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const sendToServerChat = vi.mocked(panelBridgeApi.sendToServerChat)
const sendToAdminChat = vi.mocked(panelBridgeApi.sendToAdminChat)
const sendToGeneralChat = vi.mocked(panelBridgeApi.sendToGeneralChat)
const getChatInfo = vi.mocked(panelBridgeApi.getChatInfo)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderChat() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Chat />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

async function setUp() {
  getPlayers.mockResolvedValue({ players: [] } as Awaited<ReturnType<typeof playersApi.getPlayers>>)
  getAppSettings.mockResolvedValue({ chatPresets: ['Test preset'] } as unknown as Awaited<ReturnType<typeof configApi.getAppSettings>>)
  getChatInfo.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)
}

describe("Chat.tsx: sending on the 'server' channel (default) gates on server.world_events", () => {
  it('disables Send and never reaches the API on click or Enter when the role lacks server.world_events', async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    await setUp()

    renderChat()

    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    const sendButton = screen.getByRole('button', { name: 'send' })

    fireEvent.change(input, { target: { value: 'hello players' } })
    expect(sendButton).toBeDisabled()
    fireEvent.click(sendButton)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(sendToServerChat).not.toHaveBeenCalled()
  })

  it('enables Send and reaches the API when the role holds server.world_events', async () => {
    mockCan = () => true
    await setUp()
    sendToServerChat.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof panelBridgeApi.sendToServerChat>>)

    renderChat()

    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    fireEvent.change(input, { target: { value: 'hello players' } })

    const sendButton = screen.getByRole('button', { name: 'send' })
    expect(sendButton).not.toBeDisabled()

    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sendToServerChat).toHaveBeenCalledWith('hello players', false))
  })
})

describe("Chat.tsx: sending on the 'admin'/'general' channels gates on players.endanger_or_impersonate, NOT server.world_events", () => {
  it("disables Send and never reaches the API on 'admin' when the role holds server.world_events but lacks players.endanger_or_impersonate", async () => {
    mockCan = (capability) => capability !== 'players.endanger_or_impersonate'
    await setUp()

    renderChat()

    fireEvent.change(screen.getByRole('combobox', { name: 'Chat channel' }), { target: { value: 'admin' } })
    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    const sendButton = screen.getByRole('button', { name: 'send' })

    fireEvent.change(input, { target: { value: 'fake admin notice' } })
    expect(sendButton).toBeDisabled()
    fireEvent.click(sendButton)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(sendToAdminChat).not.toHaveBeenCalled()
  })

  it("disables Send and never reaches the API on 'general' when the role holds server.world_events but lacks players.endanger_or_impersonate", async () => {
    mockCan = (capability) => capability !== 'players.endanger_or_impersonate'
    await setUp()

    renderChat()

    fireEvent.change(screen.getByRole('combobox', { name: 'Chat channel' }), { target: { value: 'general' } })
    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    const sendButton = screen.getByRole('button', { name: 'send' })

    fireEvent.change(input, { target: { value: 'pretend to be someone else' } })
    expect(sendButton).toBeDisabled()
    fireEvent.click(sendButton)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(sendToGeneralChat).not.toHaveBeenCalled()
  })

  it("enables Send and reaches the API on 'admin' when the role holds players.endanger_or_impersonate even without server.world_events", async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    await setUp()
    sendToAdminChat.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof panelBridgeApi.sendToAdminChat>>)

    renderChat()

    fireEvent.change(screen.getByRole('combobox', { name: 'Chat channel' }), { target: { value: 'admin' } })
    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    fireEvent.change(input, { target: { value: 'real admin notice' } })

    const sendButton = screen.getByRole('button', { name: 'send' })
    expect(sendButton).not.toBeDisabled()

    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sendToAdminChat).toHaveBeenCalledWith('real admin notice'))
  })

  it("enables Send and reaches the API on 'general' when the role holds players.endanger_or_impersonate even without server.world_events", async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    await setUp()
    sendToGeneralChat.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof panelBridgeApi.sendToGeneralChat>>)

    renderChat()

    fireEvent.change(screen.getByRole('combobox', { name: 'Chat channel' }), { target: { value: 'general' } })
    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    fireEvent.change(input, { target: { value: 'hello from "Admin"' } })

    const sendButton = screen.getByRole('button', { name: 'send' })
    expect(sendButton).not.toBeDisabled()

    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sendToGeneralChat).toHaveBeenCalledWith('hello from "Admin"', 'Admin'))
  })
})

describe('Chat.tsx: quick-broadcast preset management gates on panel.settings', () => {
  it('disables Add/Save/Delete and never reaches the API, even via Enter, when the role lacks panel.settings', async () => {
    mockCan = (capability) => capability !== 'panel.settings'
    await setUp()

    renderChat()

    await screen.findByText('Test preset')
    fireEvent.click(screen.getByRole('button', { name: 'Edit presets' }))

    const addInput = screen.getByPlaceholderText('add a new quick message…')
    fireEvent.change(addInput, { target: { value: 'A new preset' } })
    expect(screen.getByLabelText('Add preset')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Add preset'))
    fireEvent.keyDown(addInput, { key: 'Enter' })

    expect(screen.getByLabelText('Delete preset 1')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Delete preset 1'))

    expect(updateAppSettings).not.toHaveBeenCalled()
  })

  it('enables Add/Save/Delete when the role holds panel.settings', async () => {
    mockCan = () => true
    await setUp()
    updateAppSettings.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof configApi.updateAppSettings>>)

    renderChat()

    await screen.findByText('Test preset')
    fireEvent.click(screen.getByRole('button', { name: 'Edit presets' }))

    expect(screen.getByLabelText('Delete preset 1')).not.toBeDisabled()

    const addInput = screen.getByPlaceholderText('add a new quick message…')
    fireEvent.change(addInput, { target: { value: 'A new preset' } })
    expect(screen.getByLabelText('Add preset')).not.toBeDisabled()
    fireEvent.click(screen.getByLabelText('Add preset'))

    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({ chatPresets: ['Test preset', 'A new preset'] }))
  })
})

describe('Chat.tsx: chat delivery-method status (getChatInfo)', () => {
  it('shows nothing before the fetch resolves and nothing if it fails -- no seeded default', async () => {
    mockCan = () => true
    await setUp()
    getChatInfo.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)

    renderChat()

    await screen.findByRole('textbox', { name: 'Chat message' })
    expect(screen.queryByText('chat delivery: native')).not.toBeInTheDocument()
    expect(screen.queryByText(/chat delivery: RCON fallback/)).not.toBeInTheDocument()
  })

  it('shows "native" when the native ChatServer API is available', async () => {
    mockCan = () => true
    await setUp()
    getChatInfo.mockResolvedValue({
      success: true,
      data: { chatServerAvailable: true, rconFallback: false },
    } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)

    renderChat()

    await waitFor(() => expect(screen.getByText('chat delivery: native')).toBeInTheDocument())
    expect(screen.queryByText(/RCON fallback/)).not.toBeInTheDocument()
  })

  it('shows the RCON fallback warning when the native ChatServer API is not available', async () => {
    mockCan = () => true
    await setUp()
    getChatInfo.mockResolvedValue({
      success: true,
      data: { chatServerAvailable: false, rconFallback: true },
    } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)

    renderChat()

    await waitFor(() => expect(screen.getByText(/chat delivery: RCON fallback/)).toBeInTheDocument())
    expect(screen.queryByText('chat delivery: native')).not.toBeInTheDocument()
  })

  it('is not fetched at all when the role lacks server.world_events', async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    await setUp()

    renderChat()

    await screen.findByRole('textbox', { name: 'Chat message' })
    expect(getChatInfo).not.toHaveBeenCalled()
  })
})
