import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import Console from '../Console'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import { serverApi, serversApi, rconApi, configApi, ApiError, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'


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

const getConsoleLog = vi.mocked(serverApi.getConsoleLog)
const clearConsoleLog = vi.mocked(serverApi.clearConsoleLog)
const getAllServers = vi.mocked(serversApi.getAll)
const getHistory = vi.mocked(rconApi.getHistory)
const testRcon = vi.mocked(configApi.testRcon)

const activeServer: ServerInstance = {
  id: 1,
  name: 'Ashenwood',
  serverName: 'Ashenwood',
  installPath: 'C:/servers/ashenwood',
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '',
  rconPort: 0,
  rconPassword: '',
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

beforeEach(() => {
  getAllServers.mockReset().mockResolvedValue({ servers: [activeServer] })
  getConsoleLog.mockReset().mockResolvedValue({ lines: ['boot ok'], size: 42, path: 'C:/servers/ashenwood/server-console.txt', exists: true })
  clearConsoleLog.mockReset().mockResolvedValue({ success: true })
  getHistory.mockReset().mockResolvedValue({ history: [] })
  testRcon.mockReset()
})

describe('Console -- server log clear button', () => {
  it('does not truncate the real log file until the operator confirms', async () => {
    render(
      <TooltipProvider>
        <ConfirmProvider>
          <Console />
        </ConfirmProvider>
      </TooltipProvider>,
    )

    const clearButton = await screen.findByRole('button', { name: /clear/i })
    fireEvent.click(clearButton)

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument())
    expect(clearConsoleLog).not.toHaveBeenCalled()
  })

  it('truncates the real log file once the operator confirms', async () => {
    render(
      <TooltipProvider>
        <ConfirmProvider>
          <Console />
        </ConfirmProvider>
      </TooltipProvider>,
    )

    const clearButton = await screen.findByRole('button', { name: /clear/i })
    fireEvent.click(clearButton)

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /erase/i }))

    await waitFor(() => expect(clearConsoleLog).toHaveBeenCalledTimes(1))
  })

  it('shows the real reason the clear failed, not a generic fallback', async () => {
    clearConsoleLog.mockRejectedValueOnce(new Error('Server data path not configured'))

    render(
      <TooltipProvider>
        <ConfirmProvider>
          <Console />
          <Toaster />
        </ConfirmProvider>
      </TooltipProvider>,
    )

    const clearButton = await screen.findByRole('button', { name: /clear/i })
    fireEvent.click(clearButton)

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /erase/i }))

    await screen.findByText('Server data path not configured')
  })

  it("the tooltip copy doesn't promise safety the button doesn't deliver", () => {
    expect(enConsole.serverLog.clearTooltip).not.toMatch(/does not delete the server log file/i)
  })
})

describe('Console -- server log path display', () => {
  it('keeps the full log path available via title when the text is truncated for space', async () => {
    render(
      <TooltipProvider>
        <ConfirmProvider>
          <Console />
        </ConfirmProvider>
      </TooltipProvider>,
    )

    const pathEl = await screen.findByText('C:/servers/ashenwood/server-console.txt')
    expect(pathEl).toHaveAttribute('title', 'C:/servers/ashenwood/server-console.txt')
  })
})

describe('Console -- RCON disconnected banner reason', () => {
  const rconReadyServer: ServerInstance = {
    ...activeServer,
    rconHost: '10.0.0.5',
    rconPort: 27015,
    rconPassword: 'hunter2',
  }

  beforeEach(() => {
    getAllServers.mockReset().mockResolvedValue({ servers: [rconReadyServer] })
  })

  async function openRconTab() {
    const tabButton = await screen.findByRole('tab', { name: /rcon console/i })
    fireEvent.mouseDown(tabButton, { button: 0 })
  }

  it('tells a reachable host with a stale password apart from a genuinely unreachable one', async () => {
    testRcon.mockRejectedValue(
      new ApiError('Authentication failed: check RCON password', {
        status: 200,
        code: 'RCON_CONNECT_AUTH_FAILED',
        data: {
          success: false,
          error: 'auth_failed',
          detail: 'Authentication failed: check RCON password',
        },
      }),
    )

    render(
      <TooltipProvider>
        <ConfirmProvider>
          <Console />
        </ConfirmProvider>
      </TooltipProvider>,
    )

    await openRconTab()

    await screen.findByText(enConsole.rcon.authFailedTitle)
    expect(screen.queryByText(enConsole.rcon.hostUnreachableTitle)).not.toBeInTheDocument()
  })

  it('shows the unreachable copy when the host itself cannot be reached', async () => {
    testRcon.mockRejectedValue(
      new ApiError('Unreachable: check host and port', {
        status: 200,
        code: 'RCON_CONNECT_UNREACHABLE',
        data: {
          success: false,
          error: 'unreachable',
          detail: 'Unreachable: check host and port',
        },
      }),
    )

    render(
      <TooltipProvider>
        <ConfirmProvider>
          <Console />
        </ConfirmProvider>
      </TooltipProvider>,
    )

    await openRconTab()

    await screen.findByText(enConsole.rcon.hostUnreachableTitle)
    expect(screen.queryByText(enConsole.rcon.authFailedTitle)).not.toBeInTheDocument()
  })
})
