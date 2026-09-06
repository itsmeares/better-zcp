import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'

// 2026-08-30, rcon-disconnect-detection-matches-prose-not-codes: Console.tsx's
// isRconDisconnectError() used to substring-match a hand-maintained copy of
// RconService.getUserFriendlyError()'s prose to decide whether a failed
// /rcon/execute response meant the RCON session had dropped -- and that copy
// had already silently drifted out of sync with the server once (a 2026-08-30
// audit found "Server is not running" was reworded server-side to "Game
// server is not running." without the client's phrase list ever being told,
// so a real disconnect stopped flipping the connection banner). Fixed by
// checking response.code === 'RCON_EXECUTE_DISCONNECTED' instead -- this file
// is the "zero test coverage for isRconDisconnectError" gap the audit named,
// exercised end to end: type a command, run it, watch the banner react to
// the code the server actually attaches.
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

async function runCommand(command: string) {
  const input = await screen.findByLabelText(/rcon command input/i)
  fireEvent.change(input, { target: { value: command } })
  const runButton = screen.getByRole('button', { name: /execute command/i })
  fireEvent.click(runButton)
}

describe('Console.tsx: RCON disconnect detection reacts to the code, not the prose', () => {
  it('flips the banner to offline when the server attaches RCON_EXECUTE_DISCONNECTED, whatever the prose currently says', async () => {
    await setUp()
    // The exact reworded message that broke the old prose-matching phrase
    // list -- proves detection no longer depends on this text at all.
    execute.mockResolvedValue({
      success: false,
      error: 'Game server is not running.',
      code: 'RCON_EXECUTE_DISCONNECTED',
    })

    renderConsole()
    await openRconTab()
    await runCommand('players')

    await waitFor(() => expect(execute).toHaveBeenCalledWith('players'))
    await screen.findByText(enConsole.rcon.offline)
  })

  // bughunt-2026-08-31-b (Angela): setUp()'s testRcon mock resolves
  // connected:true, so rconConnected starts true here -- unlike the test
  // above and every other Console fixture, which start from a probe that
  // never succeeded (127.0.0.1:1 in the real tour demo profile) and so can
  // only ever show hostUnreachable copy. This is the one shape that can
  // actually reach 'dropped': the connection genuinely worked, then failed
  // mid-session. The persistent banner must say so, not recycle
  // hostUnreachable's "go check host/port/password" advice -- those were
  // just proven correct seconds earlier.
  it('shows the dropped-mid-session banner copy, not the generic host-unreachable copy, after a connection that was working fails', async () => {
    await setUp()
    execute.mockResolvedValue({
      success: false,
      error: 'Game server is not running.',
      code: 'RCON_EXECUTE_DISCONNECTED',
    })

    renderConsole()
    await openRconTab()
    await runCommand('players')

    await waitFor(() => expect(execute).toHaveBeenCalledWith('players'))
    await screen.findByText(enConsole.rcon.droppedTitle)
    await screen.findByText(enConsole.rcon.droppedDesc)
    expect(screen.queryByText(enConsole.rcon.hostUnreachableTitle)).not.toBeInTheDocument()
  })

  it('does NOT flip the banner to offline for a real authentication failure (no RCON_EXECUTE_DISCONNECTED code) -- a wrong password is not a disconnect', async () => {
    await setUp()
    execute.mockResolvedValue({
      success: false,
      error: 'Authentication failed. Check RCON password in server settings.',
      code: null,
    })

    renderConsole()
    await openRconTab()
    await runCommand('players')

    await waitFor(() => expect(execute).toHaveBeenCalledWith('players'))
    // Give the (absent) state update a tick to have happened before asserting
    // its absence -- otherwise a false pass could just mean "too early".
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(enConsole.rcon.offline)).not.toBeInTheDocument()
  })

  it('recovers via the Recheck button after a disconnect, and stays online on the next command', async () => {
    await setUp()
    execute.mockResolvedValueOnce({
      success: false,
      error: 'Game server is not running.',
      code: 'RCON_EXECUTE_DISCONNECTED',
    })

    renderConsole()
    await openRconTab()
    await runCommand('players')
    await screen.findByText(enConsole.rcon.offline)

    // 2026-08-31 (bughunt-2026-08-31-b): this used to retry by clicking Run
    // again directly. Console.tsx's disabled-input fix now correctly
    // disables Run (and the command input) the instant rconConnected flips
    // false -- a page reading HOST UNREACHABLE can't also offer a live
    // command box in the same frame -- so that retry path is no longer
    // clickable, on purpose. What this test verifies hasn't changed (a
    // genuinely successful outcome flips the banner back online); only the
    // route to get there has: an explicit Recheck, the one control
    // deliberately never gated on rconConnected itself, and exactly the
    // recovery path DisabledReason's extended message now points the
    // operator at (see rcon.disconnectedUseRecheck).
    testRcon.mockResolvedValueOnce({ success: true, connected: true })
    const recheckButton = screen.getByRole('button', { name: /recheck/i })
    fireEvent.click(recheckButton)
    await screen.findByText(enConsole.rcon.online)

    // The command input is usable again post-recovery, and a further
    // successful command doesn't regress the banner back to offline.
    execute.mockResolvedValueOnce({ success: true, response: '1 player online' })
    await runCommand('players')

    await screen.findByText(enConsole.rcon.online)
  })
})
