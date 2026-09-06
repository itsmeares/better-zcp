import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'


vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: null },
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
    rconApi: {
      ...actual.rconApi,
      execute: vi.fn(),
      getHistory: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const execute = vi.mocked(rconApi.execute)
const getHistory = vi.mocked(rconApi.getHistory)
const getAllServers = vi.mocked(serversApi.getAll)
const testRcon = vi.mocked(configApi.testRcon)

const rconConfiguredServer: ServerInstance = {
  id: 1,
  name: 'Ashenwood',
  serverName: 'Ashenwood',
  installPath: '',
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '10.0.0.5',
  rconPort: 27015,
  rconPassword: 'hunter2',
  serverPort: 16261,
  minMemory: 2048,
  maxMemory: 4096,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: true,
  startCommand: '',
  adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderConsole() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Console />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

async function openRconTab() {
  const tabButton = await screen.findByRole('tab', { name: /rcon console/i })
  fireEvent.mouseDown(tabButton, { button: 0 })
}

describe('Console.tsx: the raw command Input and Run button gate on rconConnected like their siblings', () => {
  it('disables the command input and Run button under a HOST UNREACHABLE state, matching the already-gated quick-command row', async () => {
    getAllServers.mockResolvedValue({ servers: [rconConfiguredServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: false })

    renderConsole()
    await openRconTab()

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/host unreachable/i)

    const input = await screen.findByLabelText(/rcon command input/i)
    const runButton = screen.getByRole('button', { name: /execute command/i })
    const quickCommandButton = screen.getByRole('button', { name: 'Players' })

    expect(input).toBeDisabled()
    expect(runButton).toBeDisabled()
    expect(quickCommandButton).toBeDisabled()

    fireEvent.click(runButton)
    await waitFor(() => expect(execute).not.toHaveBeenCalled())
  })

  it('keeps the command input and Run button enabled once RCON reconnects', async () => {
    getAllServers.mockResolvedValue({ servers: [rconConfiguredServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })

    renderConsole()
    await openRconTab()

    const input = await screen.findByLabelText(/rcon command input/i)
    expect(input).not.toBeDisabled()

    fireEvent.change(input, { target: { value: 'players' } })
    const runButton = screen.getByRole('button', { name: /execute command/i })
    expect(runButton).not.toBeDisabled()
  })
})
