import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'


vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
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
    schedulerApi: {
      ...actual.schedulerApi,
      getTasks: vi.fn(),
      getCronPresets: vi.fn(),
      getStatus: vi.fn(),
      getHistory: vi.fn(),
      setTimezone: vi.fn(),
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
const setTimezone = vi.mocked(schedulerApi.setTimezone)
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

async function baseMocks() {
  getTasks.mockResolvedValue({ tasks: [] })
  getCronPresets.mockResolvedValue({ presets: [] })
  getHistory.mockResolvedValue({ history: [] })
  serversGetAll.mockResolvedValue({ servers: [] })
  serverGetStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
}

describe('Scheduler.tsx: timezone settings card (always visible)', () => {
  it('shows the operator-configured zone and the currently-effective zone', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'America/New_York',
      configuredTimezone: 'America/New_York',
      timezoneFallback: null,
    })

    renderScheduler()

    const input = await screen.findByLabelText('IANA timezone name')
    await waitFor(() => expect(input).toHaveValue('America/New_York'))
    expect(screen.getByText(/Currently in effect: America\/New_York/)).toBeInTheDocument()
    expect(screen.queryByText(/no longer valid/i)).not.toBeInTheDocument()
  })

  it('shows the fallback warning with BOTH zones when the saved zone is no longer valid', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: 'Not/AZone',
      timezoneFallback: { configured: 'Not/AZone', effective: 'UTC' },
    })

    renderScheduler()

    expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument()
    expect(screen.getByText(/Not\/AZone/)).toBeInTheDocument()
    expect(screen.getByText(/Currently in effect: UTC/)).toBeInTheDocument()
  })

  it('saving a new zone calls the API and shows a success toast', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: 'UTC',
      timezoneFallback: null,
    })
    setTimezone.mockResolvedValue({
      success: true,
      timezone: 'Europe/Berlin',
      configuredTimezone: 'Europe/Berlin',
      timezoneFallback: null,
    })

    renderScheduler()

    const input = await screen.findByLabelText('IANA timezone name')
    await waitFor(() => expect(input).toHaveValue('UTC'))
    fireEvent.change(input, { target: { value: 'Europe/Berlin' } })

    const saveButton = screen.getByRole('button', { name: 'Save' })
    await waitFor(() => expect(saveButton).not.toBeDisabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(setTimezone).toHaveBeenCalledWith('Europe/Berlin'))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success', description: expect.stringContaining('Europe/Berlin') }),
      ),
    )
  })

  it('a failed save shows an error toast, not a silent no-op', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: 'UTC',
      timezoneFallback: null,
    })
    setTimezone.mockRejectedValue(new Error('not a valid IANA timezone'))

    renderScheduler()

    const input = await screen.findByLabelText('IANA timezone name')
    await waitFor(() => expect(input).toHaveValue('UTC'))
    fireEvent.change(input, { target: { value: 'Not/AZone' } })

    const saveButton = screen.getByRole('button', { name: 'Save' })
    await waitFor(() => expect(saveButton).not.toBeDisabled())
    fireEvent.click(saveButton)

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })),
    )
  })
})

describe('Scheduler.tsx: the create/edit-task dialog also discloses the effective timezone', () => {
  it('shows the real, currently-effective server timezone from getStatus(), not the browser timezone', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'America/New_York',
      configuredTimezone: 'America/New_York',
      timezoneFallback: null,
    })

    renderScheduler()

    fireEvent.click(await screen.findByRole('button', { name: 'New Task' }))
    const dialog = await screen.findByRole('dialog')

    expect(await within(dialog).findByText(/America\/New_York/)).toBeInTheDocument()
  })

  it('shows nothing extra (no crash, no blank/undefined text) when getStatus() has not resolved a timezone', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
    })

    renderScheduler()

    fireEvent.click(await screen.findByRole('button', { name: 'New Task' }))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).queryByText(/undefined/)).not.toBeInTheDocument()
  })
})

describe('Scheduler.tsx: timezone card is a searchable picker, not a bare free-text field (2026-08-31)', () => {
  it('typing filters the dropdown to matching timezones only', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: 'UTC',
      timezoneFallback: null,
    })

    renderScheduler()

    const input = await screen.findByLabelText('IANA timezone name')
    await waitFor(() => expect(input).toHaveValue('UTC'))
    fireEvent.change(input, { target: { value: 'Berlin' } })

    const listbox = await screen.findByRole('listbox', { name: 'IANA timezone name' })
    expect(await within(listbox).findByRole('option', { name: 'Europe/Berlin' })).toBeInTheDocument()
    expect(within(listbox).queryByRole('option', { name: 'America/New_York' })).not.toBeInTheDocument()
  })

  it('clicking a filtered option selects it, and Save persists that exact value', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: 'UTC',
      timezoneFallback: null,
    })
    setTimezone.mockResolvedValue({
      success: true,
      timezone: 'Europe/Berlin',
      configuredTimezone: 'Europe/Berlin',
      timezoneFallback: null,
    })

    renderScheduler()

    const input = await screen.findByLabelText('IANA timezone name')
    await waitFor(() => expect(input).toHaveValue('UTC'))
    fireEvent.change(input, { target: { value: 'Berlin' } })

    const listbox = await screen.findByRole('listbox', { name: 'IANA timezone name' })
    fireEvent.click(await within(listbox).findByRole('option', { name: 'Europe/Berlin' }))
    expect(input).toHaveValue('Europe/Berlin')

    const saveButton = screen.getByRole('button', { name: 'Save' })
    await waitFor(() => expect(saveButton).not.toBeDisabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(setTimezone).toHaveBeenCalledWith('Europe/Berlin'))
  })

  it('a saved zone missing from the built-in list is still shown verbatim in the input, not blanked or reset to UTC', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: 'Not/AZone',
      timezoneFallback: { configured: 'Not/AZone', effective: 'UTC' },
    })

    renderScheduler()

    const input = await screen.findByLabelText('IANA timezone name')
    await waitFor(() => expect(input).toHaveValue('Not/AZone'))
  })

  it('offers UTC even though it is absent from Intl.supportedValuesOf("timeZone")', async () => {
    expect(Intl.supportedValuesOf('timeZone')).not.toContain('UTC')

    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: '',
      timezoneFallback: null,
    })

    renderScheduler()

    const input = await screen.findByLabelText('IANA timezone name')
    fireEvent.focus(input)

    const listbox = await screen.findByRole('listbox', { name: 'IANA timezone name' })
    expect(await within(listbox).findByRole('option', { name: 'UTC' })).toBeInTheDocument()
  })
})
