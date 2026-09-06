import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'


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

const rconReadyServer: ServerInstance = {
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

function createFakeSocket(connected: boolean) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    connected,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler)
    }),
    emit: vi.fn(),
  }
  return {
    socket: socket as unknown as Socket,
    trigger: (event: string, data?: unknown) => {
      listeners.get(event)?.forEach((h) => h(data))
    },
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = (_capability: string) => true
})

function renderConsole(socket: Socket | null) {
  return render(
    <SocketContext.Provider value={socket}>
      <TooltipProvider>
        <ConfirmProvider>
          <Console />
        </ConfirmProvider>
      </TooltipProvider>
    </SocketContext.Provider>,
  )
}

async function setUp() {
  getAllServers.mockResolvedValue({ servers: [rconReadyServer] })
  getHistory.mockResolvedValue({ history: [] })
  testRcon.mockResolvedValue({ success: true, connected: true })
}

async function openRconTab() {
  const tabButton = await screen.findByRole('tab', { name: /rcon console/i })
  fireEvent.mouseDown(tabButton, { button: 0 })
}

async function runCommand(command: string) {
  const input = await screen.findByLabelText(/rcon command input/i)
  fireEvent.change(input, { target: { value: command } })
  const runButton = screen.getByRole('button', { name: /execute command/i })
  fireEvent.click(runButton)
}

describe('Console.tsx: the live log fills from the rcon-live broadcast alone, exactly once, for any rcon.execute caller', () => {
  it('shows the command\'s own rcon:response broadcast exactly once for a role without diagnostics.manage, not twice', async () => {
    mockCan = (capability) => capability !== 'diagnostics.manage'
    await setUp()
    execute.mockResolvedValue({ success: true, response: '1 player online' })

    const { socket, trigger } = createFakeSocket(true)

    renderConsole(socket)
    await openRconTab()
    await runCommand('players')

    await waitFor(() => expect(execute).toHaveBeenCalledWith('players'))

    trigger('rcon:response', {
      command: 'players',
      response: '1 player online',
      success: true,
      timestamp: new Date().toISOString(),
    })

    await screen.findByText('players')
    await screen.findByText('1 player online')
    expect(screen.queryByText(enConsole.rcon.noCommandsTitle)).not.toBeInTheDocument()
  }, 10000)
})

describe('Console.tsx: a socket rcon:response only proves the connection is live when it succeeded', () => {
  it('does not flip the offline banner back to online on a failed rcon:response broadcast', async () => {
    await setUp()
    execute.mockResolvedValue({
      success: false,
      error: 'Game server is not running.',
      code: 'RCON_EXECUTE_DISCONNECTED',
    })

    const { socket, trigger } = createFakeSocket(true)
    renderConsole(socket)
    await openRconTab()
    await runCommand('players')
    await screen.findByText(enConsole.rcon.offline)

    trigger('rcon:response', {
      command: 'players',
      response: 'Game server is not running.',
      success: false,
      timestamp: new Date().toISOString(),
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(enConsole.rcon.online)).not.toBeInTheDocument()
    expect(screen.getByText(enConsole.rcon.offline)).toBeInTheDocument()
  })

  it('does flip the offline banner back to online on a successful rcon:response broadcast', async () => {
    await setUp()
    execute.mockResolvedValue({
      success: false,
      error: 'Game server is not running.',
      code: 'RCON_EXECUTE_DISCONNECTED',
    })

    const { socket, trigger } = createFakeSocket(true)
    renderConsole(socket)
    await openRconTab()
    await runCommand('players')
    await screen.findByText(enConsole.rcon.offline)

    trigger('rcon:response', {
      command: 'players',
      response: '1 player online',
      success: true,
      timestamp: new Date().toISOString(),
    })

    await screen.findByText(enConsole.rcon.online)
  })
})
