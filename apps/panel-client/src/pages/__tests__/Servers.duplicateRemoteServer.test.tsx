import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from '@/lib/routerCompat'
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
      create: vi.fn(),
      activate: vi.fn(),
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
const create = vi.mocked(serversApi.create)
const activate = vi.mocked(serversApi.activate)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

const EXISTING_REMOTE_SERVER = {
  id: 1,
  name: 'Tour Remote Server',
  serverName: 'servertest',
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
} as never

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

async function openAddRemoteServerDialog() {
  fireEvent.click(await screen.findByRole('button', { name: en.pageHeader.addRemote }))
  await screen.findByRole('heading', { name: en.addDialog.titleRemote })
}

function fillRemoteForm(name: string, host: string, password = 'tourdemo') {
  fireEvent.change(screen.getByPlaceholderText(en.remoteForm.displayNamePlaceholder), { target: { value: name } })
  fireEvent.change(screen.getByPlaceholderText(en.remoteForm.hostPlaceholder), { target: { value: host } })
  fireEvent.change(screen.getByPlaceholderText(en.remoteForm.rconPasswordPlaceholder), { target: { value: password } })
}

beforeEach(() => {
  getAll.mockReset().mockResolvedValue({ servers: [EXISTING_REMOTE_SERVER] } as never)
  getStatus.mockReset().mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockReset().mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockReset().mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockReset().mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  getAppSettings.mockReset().mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockReset().mockResolvedValue({} as never)
  create.mockReset().mockResolvedValue({ server: { id: 2 } } as never)
  activate.mockReset().mockResolvedValue({} as never)
  toastSpy.mockClear()
})

describe('Servers -- Add Remote Server duplicate detection', () => {
  it('blocks submission and never calls create when name + RCON host + RCON port all match an existing remote server', async () => {
    renderServers()
    await openAddRemoteServerDialog()
    fillRemoteForm('Tour Remote Server', '192.168.1.50')

    fireEvent.click(screen.getByRole('button', { name: en.addDialog.addServer }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: en.toasts.duplicateRemoteServer.replace('{{name}}', 'Tour Remote Server'),
          variant: 'destructive',
        }),
      ),
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('is case/whitespace-insensitive on the name and host', async () => {
    renderServers()
    await openAddRemoteServerDialog()
    fillRemoteForm('  TOUR REMOTE SERVER  ', '  192.168.1.50  ')

    fireEvent.click(screen.getByRole('button', { name: en.addDialog.addServer }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(create).not.toHaveBeenCalled()
  })

  it('does not block a genuinely different remote server (different host)', async () => {
    renderServers()
    await openAddRemoteServerDialog()
    fillRemoteForm('Tour Remote Server', '192.168.1.51')

    fireEvent.click(screen.getByRole('button', { name: en.addDialog.addServer }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('already on the list') }),
    )
  })

  it('does not block a genuinely different remote server (different name, same host)', async () => {
    renderServers()
    await openAddRemoteServerDialog()
    fillRemoteForm('A Second Server', '192.168.1.50')

    fireEvent.click(screen.getByRole('button', { name: en.addDialog.addServer }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  })
})
