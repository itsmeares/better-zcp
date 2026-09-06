import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// bug-hunt-2026-08-27 (Jim's ranked list, #2): the operator could type a
// custom restart-warning time above 60 minutes into the "Custom Time" field
// (its min/max={1,30} are decorative -- NumberInput only enforces a bound
// via native <input> attrs unless a `clamp` prop is also passed, and
// Scheduler.tsx's usage here doesn't pass one). The server (scheduler.js's
// POST /restart-now) has always silently capped the value at 60 minutes,
// but its response never said so -- the client's toast just echoed back
// whatever the operator typed, so an operator who entered 500 saw "Server
// will restart in 500 minutes" while the real countdown was 60.
//
// The 60-minute bound itself is being KEPT, not removed -- an unbounded
// "restart now with a warning" is a contradiction in terms, and the
// countdown/restartInProgress state has to resolve in a sane window. The
// fix is telling the operator when their value was substituted, not
// removing the substitution.

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
    schedulerApi: {
      ...actual.schedulerApi,
      getTasks: vi.fn(),
      getCronPresets: vi.fn(),
      getStatus: vi.fn(),
      getHistory: vi.fn(),
      restartNow: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getTasks = vi.mocked(schedulerApi.getTasks)
const getCronPresets = vi.mocked(schedulerApi.getCronPresets)
const getStatus = vi.mocked(schedulerApi.getStatus)
const getHistory = vi.mocked(schedulerApi.getHistory)
const restartNow = vi.mocked(schedulerApi.restartNow)
const serversGetAll = vi.mocked(serversApi.getAll)
const serverGetStatus = vi.mocked(serverApi.getStatus)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderScheduler() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Scheduler />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUpRunningServer() {
  getTasks.mockResolvedValue({ tasks: [] })
  getCronPresets.mockResolvedValue({ presets: [] })
  getStatus.mockResolvedValue({ activeTasks: 0, autoRestartEnabled: false, modUpdateRestartPending: false })
  getHistory.mockResolvedValue({ history: [] })
  serversGetAll.mockResolvedValue({ servers: [] })
  serverGetStatus.mockResolvedValue({ running: true } as Awaited<ReturnType<typeof serverApi.getStatus>>)
}

describe('Scheduler.tsx: the custom restart-warning time reports the real, possibly-clamped value', () => {
  it('typing 500 into the custom-time field (past the decorative max={30}) and clicking Restart Now surfaces the server-clamped value, not the typed one', async () => {
    mockCan = () => true
    await setUpRunningServer()
    // The server's real 60-minute cap, reported back honestly.
    restartNow.mockResolvedValue({ success: true, message: 'Restart initiated', warningMinutes: 60 })

    renderScheduler()

    await waitFor(() => expect(screen.getByRole('spinbutton')).toBeInTheDocument())
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } })

    const restartNowButton = await screen.findByRole('button', { name: 'Restart Now' })
    await waitFor(() => expect(restartNowButton).not.toBeDisabled())
    fireEvent.click(restartNowButton)

    await waitFor(() => expect(restartNow).toHaveBeenCalledWith(500))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'warning',
          description: expect.stringContaining('60'),
        }),
      ),
    )
    // The misleading behavior this replaces: a plain success toast claiming
    // the server WILL restart in 500 minutes, as if that were honored.
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'success' }),
    )
  })

  it('typing 20 (under the 60-minute cap) and clicking Restart Now shows the plain success toast, no clamp warning', async () => {
    mockCan = () => true
    await setUpRunningServer()
    restartNow.mockResolvedValue({ success: true, message: 'Restart initiated', warningMinutes: 20 })

    renderScheduler()

    await waitFor(() => expect(screen.getByRole('spinbutton')).toBeInTheDocument())
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } })

    const restartNowButton = await screen.findByRole('button', { name: 'Restart Now' })
    await waitFor(() => expect(restartNowButton).not.toBeDisabled())
    fireEvent.click(restartNowButton)

    await waitFor(() => expect(restartNow).toHaveBeenCalledWith(20))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success', description: expect.stringContaining('20') }),
      ),
    )
  })
})
