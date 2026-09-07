import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from '@/test/router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi } from '@/lib/api'
import en from '../../locales/en/servers.json'


vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
      update: vi.fn(),
    },
    serversDetectApi: {
      ...actual.serversDetectApi,
      detect: vi.fn(),
      autoScan: vi.fn(),
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const update = vi.mocked(serversApi.update)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

function makeRemoteServer(overrides: Record<string, unknown>) {
  return {
    id: 1,
    name: 'Server One',
    serverName: 'server-one',
    installPath: '',
    zomboidDataPath: null,
    serverConfigPath: null,
    rconHost: '192.168.1.50',
    rconPort: 27015,
    rconPassword: '',
    serverPort: 16261,
    minMemory: 2,
    maxMemory: 4,
    useNoSteam: false,
    useDebug: false,
    isRemote: true,
    isActive: false,
    startCommand: '',
    adminPassword: '',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  } as never
}

const SERVER_ONE = makeRemoteServer({ id: 1, name: 'Server One', rconHost: '192.168.1.50', rconPort: 27015 })
const SERVER_TWO = makeRemoteServer({ id: 2, name: 'Server Two', rconHost: '192.168.1.51', rconPort: 27016 })

function renderServers() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

async function openEditDialogFor(serverName: string) {
  const trigger = await screen.findByRole('button', { name: `Options for ${serverName}` })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByText(en.card.edit))
  await screen.findByRole('heading', { name: en.editDialog.title })
}

beforeEach(() => {
  getAll.mockReset().mockResolvedValue({ servers: [SERVER_ONE, SERVER_TWO] } as never)
  getStatus.mockReset().mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockReset().mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockReset().mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockReset().mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  getAppSettings.mockReset().mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockReset().mockResolvedValue({} as never)
  update.mockReset().mockResolvedValue({ server: SERVER_TWO, warnings: [] } as never)
  toastSpy.mockClear()
})

describe('Servers -- Edit Server duplicate detection (extends f557c795 to the update path)', () => {
  it('blocks saving Server Two when its name+host+port are edited to match Server One, and never calls update', async () => {
    renderServers()
    await openEditDialogFor('Server Two')

    const nameInput = screen.getByDisplayValue('Server Two')
    fireEvent.change(nameInput, { target: { value: 'Server One' } })
    const hostInput = screen.getByPlaceholderText(en.editDialog.rconHostPlaceholderRemote)
    fireEvent.change(hostInput, { target: { value: '192.168.1.50' } })
    const portInput = screen.getByDisplayValue('27016')
    fireEvent.change(portInput, { target: { value: '27015' } })

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: en.toasts.duplicateRemoteServer.replace('{{name}}', 'Server One'),
          variant: 'destructive',
        }),
      ),
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps a persistent invalid marker on the two colliding fields after the blocked-save toast fades (the servers:duplicate-edit finding)', async () => {
    renderServers()
    await openEditDialogFor('Server Two')

    const nameInput = screen.getByDisplayValue('Server Two')
    fireEvent.change(nameInput, { target: { value: 'Server One' } })
    const hostInput = screen.getByPlaceholderText(en.editDialog.rconHostPlaceholderRemote)
    fireEvent.change(hostInput, { target: { value: '192.168.1.50' } })
    const portInput = screen.getByDisplayValue('27016')
    fireEvent.change(portInput, { target: { value: '27015' } })

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())

    expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    expect(hostInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getAllByText(en.editDialog.duplicateRemoteServerHint)).toHaveLength(2)

    fireEvent.change(hostInput, { target: { value: '192.168.1.99' } })
    expect(nameInput).not.toHaveAttribute('aria-invalid', 'true')
    expect(hostInput).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText(en.editDialog.duplicateRemoteServerHint)).not.toBeInTheDocument()
  })

  it('does not block saving a server unchanged (excludes the server being edited from its own comparison)', async () => {
    renderServers()
    await openEditDialogFor('Server Two')

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  })

  it('does not block saving a server with an unrelated field changed and no collision', async () => {
    renderServers()
    await openEditDialogFor('Server Two')

    const nameInput = screen.getByDisplayValue('Server Two')
    fireEvent.change(nameInput, { target: { value: 'Server Two Renamed' } })

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('already on the list') }),
    )
  })
})
