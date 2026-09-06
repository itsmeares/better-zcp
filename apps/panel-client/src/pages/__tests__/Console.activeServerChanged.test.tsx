import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import Console from '../Console'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'


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
    serverApi: {
      ...actual.serverApi,
      getConsoleLog: vi.fn(),
      streamConsoleLog: vi.fn(),
      clearConsoleLog: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    rconApi: { ...actual.rconApi, getHistory: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getConsoleLog = vi.mocked(serverApi.getConsoleLog)
const clearConsoleLog = vi.mocked(serverApi.clearConsoleLog)
const getAllServers = vi.mocked(serversApi.getAll)
const getHistory = vi.mocked(rconApi.getHistory)
const testRcon = vi.mocked(configApi.testRcon)

function makeServer(overrides: Partial<ServerInstance>): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '', rconPort: 0, rconPassword: '',
    serverPort: 16261, minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false,
    isRemote: false, isActive: true, startCommand: '', adminPassword: '',
    createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

const serverA = makeServer({ id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood' })
const serverB = makeServer({ id: 2, name: 'Brightmoor', serverName: 'Brightmoor', installPath: null, zomboidDataPath: null })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
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

describe('Console.tsx: tracks the active server across a switch', () => {
  it('reloads the active server on activeServerChanged instead of staying pinned to the one from mount', async () => {
    getAllServers
      .mockResolvedValueOnce({ servers: [serverA] })
      .mockResolvedValueOnce({ servers: [serverB] })
    getConsoleLog.mockResolvedValue({ lines: ['boot ok'], size: 42, path: 'C:/servers/ashenwood/server-console.txt', exists: true })
    clearConsoleLog.mockResolvedValue({ success: true })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockReset()

    renderConsole()

    await screen.findByText('boot ok')
    expect(getAllServers).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Server log path not configured')).not.toBeInTheDocument()

    await act(async () => { emitActiveServerChanged() })

    expect(await screen.findByText('Server log path not configured', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(getAllServers).toHaveBeenCalledTimes(2)
  })
})
