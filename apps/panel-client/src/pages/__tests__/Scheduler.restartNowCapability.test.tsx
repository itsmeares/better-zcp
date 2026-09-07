import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from '@/lib/routerCompat'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'


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
  restartNow.mockImplementation(async (minutes) => ({
    success: true,
    message: 'Restart initiated',
    warningMinutes: minutes ?? 0,
  }))
}

describe('Scheduler.tsx: Restart Now buttons gate on server.control, not just page access', () => {
  it('disables every restart-now entry point, and a click on any of them never calls the API, when the role lacks server.control', async () => {
    mockCan = (capability) => capability !== 'server.control'
    await setUpRunningServer()

    renderScheduler()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart in 15m' })).toBeInTheDocument())

    const buttonNames = ['Restart in 15m', 'Restart in 10m', 'Restart in 5m', 'Restart in 1m', 'Restart Now']
    const buttons = buttonNames.map((name) => screen.getByRole('button', { name }))
    for (const button of buttons) {
      expect(button).toBeDisabled()
    }

    for (const button of buttons) {
      fireEvent.click(button)
    }

    expect(restartNow).not.toHaveBeenCalled()
  })

  it('enables every restart-now entry point when the role holds server.control', async () => {
    mockCan = () => true
    await setUpRunningServer()

    renderScheduler()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart in 15m' })).toBeInTheDocument())

    const buttonNames = ['Restart in 15m', 'Restart in 10m', 'Restart in 5m', 'Restart in 1m', 'Restart Now']
    for (const name of buttonNames) {
      expect(screen.getByRole('button', { name })).not.toBeDisabled()
    }
  })

  it('actually opens the confirm dialog and calls the API when "Restart in 1m" is clicked with server.control granted', async () => {
    mockCan = () => true
    await setUpRunningServer()

    renderScheduler()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart in 1m' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Restart in 1m' }))

    await screen.findByText('Restart server in 1 minute?')

    fireEvent.click(screen.getByRole('button', { name: 'Restart in 1m' }))

    await waitFor(() => expect(restartNow).toHaveBeenCalledWith(1))
  })

  it('actually opens the confirm dialog and calls the API for the short-countdown "Restart Now" path with server.control granted', async () => {
    mockCan = () => true
    await setUpRunningServer()

    renderScheduler()

    await waitFor(() => expect(screen.getByRole('spinbutton')).toBeInTheDocument())
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart Now' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Restart Now' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Restart in 2m' }))

    await waitFor(() => expect(restartNow).toHaveBeenCalledWith(2))
  })
})
