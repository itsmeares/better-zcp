import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// bug-hunt-2026-08-26 (Jim's ranked list, #7): the "Advanced (Cron)" tab's
// Save gate used to run a local regex (isValidCron: exactly 5 whitespace-
// separated fields, each matching /^[\d*,\/-]+$/) instead of the server's
// real node-cron validator (cron.validate() + the app's own field-count and
// too-frequent rules). Enumerating a battery of hand-picked expressions
// against both showed real divergence in BOTH directions:
//   - client accepts, server rejects (17/40 candidates): the local regex has
//     no numeric bounds at all, so "99 * * * *", "* 25 * * *", "60 0 * * *",
//     "0 0 31 2 *" (Feb 31st), "* * * * *" (too-frequent), etc. all showed a
//     green tick and then failed one network round-trip later, at Save.
//   - client rejects, server accepts (9/40 candidates): the local regex
//     rejects any letter outright, so "0 12 * JAN *", "0 12 * * MON",
//     "0 0 L * *" (last day of month), "0 0 * * MON#2" (2nd Monday), etc.
//     were refused by the client even though node-cron and the server
//     happily accept them -- denying the operator a schedule they were
//     entitled to.
// The fix removes the local regex entirely and delegates to the same
// POST /scheduler/validate-cron endpoint the live preview above the field
// already calls, getting exact parity by construction instead of hand-
// porting node-cron's bounds/name/token tables and keeping them in sync.

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
      validateCron: vi.fn(),
      createTask: vi.fn(),
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
const validateCron = vi.mocked(schedulerApi.validateCron)
const createTask = vi.mocked(schedulerApi.createTask)
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

async function setUp() {
  getTasks.mockResolvedValue({ tasks: [] })
  getCronPresets.mockResolvedValue({ presets: [] })
  getStatus.mockResolvedValue({ activeTasks: 0, autoRestartEnabled: false, modUpdateRestartPending: false })
  getHistory.mockResolvedValue({ history: [] })
  serversGetAll.mockResolvedValue({ servers: [] })
  serverGetStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
}

async function openAdvancedTaskDialog(cron: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'New Task' }))
  fireEvent.change(await screen.findByPlaceholderText('e.g., Daily Restart'), { target: { value: 'A task' } })
  // Radix's TabsTrigger switches on mousedown, not click (see Console.test.tsx's openRconTab).
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Advanced (Cron)' }), { button: 0 })
  fireEvent.change(await screen.findByPlaceholderText('e.g., 0 */2 * * *'), { target: { value: cron } })
  fireEvent.change(screen.getByPlaceholderText('Or enter custom command'), { target: { value: 'restart' } })
}

describe('Scheduler.tsx: Advanced-tab Save delegates cron validity to the server, not a local regex', () => {
  it('a cron the local regex would call syntactically fine but the server rejects (out-of-range minute) is blocked before ever calling createTask', async () => {
    mockCan = () => true
    await setUp()
    validateCron.mockResolvedValue({ valid: false, error: 'Invalid cron expression format' })

    renderScheduler()
    await openAdvancedTaskDialog('99 * * * *')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))

    await waitFor(() => expect(validateCron).toHaveBeenCalledWith('99 * * * *'))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive', description: expect.stringContaining('Invalid cron expression format') }),
      ),
    )
    expect(createTask).not.toHaveBeenCalled()
  })

  it('a cron with a named weekday the local regex would reject outright (letters) but the server accepts is created successfully', async () => {
    mockCan = () => true
    await setUp()
    validateCron.mockResolvedValue({ valid: true })
    createTask.mockResolvedValue({ success: true, task: {} } as Awaited<ReturnType<typeof schedulerApi.createTask>>)

    renderScheduler()
    await openAdvancedTaskDialog('0 12 * * MON')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))

    await waitFor(() => expect(validateCron).toHaveBeenCalledWith('0 12 * * MON'))
    await waitFor(() => expect(createTask).toHaveBeenCalledWith('A task', '0 12 * * MON', 'restart', undefined))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' })),
    )
  })
})
