import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'

// bug-hunt-2026-08-26 Tier 1: POST /rcon/execute (apps/panel-server/routes/rcon.js) is
// correctly gated server-side by requirePermission('rcon.execute') -- traced
// and confirmed by hand, not inferred from the capability existing in the
// list -- but Console.tsx itself had zero client-side awareness of that.
// Both entry points that reach rconApi.execute (the typed-command Run
// button/Enter key via executeCommand, and the broadcast Send button via
// sendAnnouncement) were disabled only on loading/!hasRconConfig, so an
// operator lacking rcon.execute saw a fully live console and got an
// unexplained 403 on every command. The command input's Enter key calls
// executeCommand directly, bypassing whatever the Run button's disabled
// state says -- exactly the kind of second entry point Templates.tsx's own
// canManage fix (and later Scheduler's) found the hard way -- so this
// asserts the ACTION is unreachable via both the button and the keyboard
// path, not just that one button looks disabled.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
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
  // Deliberately empty -- this makes hasServerLogSource false so Console.tsx
  // never starts its server-log polling (real serverApi.getConsoleLog /
  // streamConsoleLog calls), which is unrelated to the RCON gating under
  // test here and isn't mocked in this file.
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

async function setUp() {
  getAllServers.mockResolvedValue({ servers: [rconReadyServer] })
  getHistory.mockResolvedValue({ history: [] })
  testRcon.mockResolvedValue({ success: true, connected: true })
}

async function openRconTab() {
  // Radix's TabsTrigger switches on mousedown, not click (see @radix-ui/react-tabs)
  const tabButton = await screen.findByRole('tab', { name: /rcon console/i })
  fireEvent.mouseDown(tabButton, { button: 0 })
}

describe('Console.tsx: RCON execute is gated on rcon.execute, not just page access', () => {
  it('disables the Run button and refuses Enter-key submission when the role lacks rcon.execute', async () => {
    mockCan = (capability) => capability !== 'rcon.execute'
    await setUp()

    renderConsole()
    await openRconTab()

    const input = await screen.findByLabelText(/rcon command input/i)
    const runButton = screen.getByRole('button', { name: /execute command/i })

    expect(runButton).toBeDisabled()

    fireEvent.click(runButton)
    expect(execute).not.toHaveBeenCalled()

    // The Run button being disabled proves nothing about the Enter key --
    // handleKeyDown calls executeCommand() directly regardless of the
    // button's own disabled attribute.
    fireEvent.change(input, { target: { value: 'players' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(execute).not.toHaveBeenCalled())
  })

  it('disables the broadcast Send button and it never calls the API when the role lacks rcon.execute', async () => {
    mockCan = (capability) => capability !== 'rcon.execute'
    await setUp()

    renderConsole()
    await openRconTab()

    const broadcastToggle = await screen.findByText('broadcast')
    fireEvent.click(broadcastToggle)

    const textarea = await screen.findByLabelText(/broadcast message/i)
    fireEvent.change(textarea, { target: { value: 'server restarting' } })

    const sendButton = screen.getByRole('button', { name: /send/i })
    expect(sendButton).toBeDisabled()

    fireEvent.click(sendButton)
    await waitFor(() => expect(execute).not.toHaveBeenCalled())
  })

  it('enables both the Run button and the broadcast Send button when the role holds rcon.execute', async () => {
    mockCan = () => true
    await setUp()

    renderConsole()
    await openRconTab()

    const input = await screen.findByLabelText(/rcon command input/i)
    fireEvent.change(input, { target: { value: 'players' } })

    const runButton = screen.getByRole('button', { name: /execute command/i })
    expect(runButton).not.toBeDisabled()

    const broadcastToggle = await screen.findByText('broadcast')
    fireEvent.click(broadcastToggle)
    const textarea = await screen.findByLabelText(/broadcast message/i)
    fireEvent.change(textarea, { target: { value: 'server restarting' } })

    const sendButton = screen.getByRole('button', { name: /send/i })
    expect(sendButton).not.toBeDisabled()
  })
})
