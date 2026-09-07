import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from '@/test/router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'


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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
      create: vi.fn(),
      activate: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      steamVerify: vi.fn(),
      steamUpdate: vi.fn(),
    },
    serversDetectApi: {
      ...actual.serversDetectApi,
      detect: vi.fn(),
      autoScan: vi.fn(),
      deleteFiles: vi.fn(),
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn(),
      getStats: vi.fn(),
      runAction: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
    serverApi: {
      ...actual.serverApi,
      detectSteamCmd: vi.fn(),
      getBranches: vi.fn(),
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
const update = vi.mocked(serversApi.update)
const del = vi.mocked(serversApi.delete)
const steamVerify = vi.mocked(serversApi.steamVerify)
const steamUpdate = vi.mocked(serversApi.steamUpdate)
const detect = vi.mocked(serversDetectApi.detect)
const autoScan = vi.mocked(serversDetectApi.autoScan)
const deleteFiles = vi.mocked(serversDetectApi.deleteFiles)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const dockerRunAction = vi.mocked(dockerApi.runAction)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)
const detectSteamCmd = vi.mocked(serverApi.detectSteamCmd)
const getBranches = vi.mocked(serverApi.getBranches)

const SERVER_A = {
  id: 1,
  name: 'server-a',
  serverName: 'server-a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server/server-a.ini',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
} as never

const SERVER_B = {
  ...(SERVER_A as object),
  id: 2,
  name: 'server-b',
  serverName: 'server-b-cfg',
  installPath: '/srv/b',
  zomboidDataPath: '/srv/b/data',
  dockerContainerName: 'docker-b',
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

async function setUpFixtures() {
  getAll.mockResolvedValue({ servers: [SERVER_A, SERVER_B] } as never)
  getStatus.mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockResolvedValue({
    enabled: true,
    available: true,
    containers: [{ id: 'docker-b', name: 'docker-b', image: 'zomboid', state: 'exited', status: 'Exited' }],
  } as never)
  dockerGetStats.mockResolvedValue({ containers: {} } as never)
  getAppSettings.mockResolvedValue({ settings: { steamcmdPath: '/opt/steamcmd' } } as never)
  updateGetStatus.mockResolvedValue({} as never)
  create.mockResolvedValue({ server: { id: 3 } } as never)
  activate.mockResolvedValue({} as never)
  update.mockResolvedValue({ warnings: [] } as never)
  del.mockResolvedValue({} as never)
  deleteFiles.mockResolvedValue({} as never)
  detectSteamCmd.mockResolvedValue({ found: false, path: null } as never)
  getBranches.mockResolvedValue({ branches: [] } as never)
}

async function openCardMenu(serverName: string) {
  const trigger = await screen.findByRole('button', { name: new RegExp(`options for ${serverName}`, 'i') })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

async function openSteamDialogForServerA() {
  const menu = await openCardMenu('server-a')
  fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.updateServer }))
  await screen.findByRole('heading', { name: en.steamDialog.updateTitle })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx: capability gating', () => {
  it('shows managed lifecycle controls only when the backend supports them', async () => {
    mockCan = () => true
    await setUpFixtures()
    getAll.mockResolvedValue({
      servers: [SERVER_A, SERVER_B],
      lifecycleCapabilities: {
        supported: true,
        platform: 'linux',
        containerized: false,
        providers: ['direct', 'systemd', 'openrc'],
      },
    } as never)
    renderServers()
    await screen.findByText('server-a')

    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
    await screen.findByRole('heading', { name: en.editDialog.title })

    expect(screen.getByText(en.editDialog.lifecycleProviderLabel)).toBeInTheDocument()
  })

  it('hides managed lifecycle controls on unsupported hosts', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
    await screen.findByRole('heading', { name: en.editDialog.title })

    expect(screen.queryByText(en.editDialog.lifecycleProviderLabel)).not.toBeInTheDocument()
  })

  it('disables every gated trigger, and clicking any of them never calls the API, when the role holds none of the six capabilities', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    const switchButtons = screen.getAllByRole('button', { name: en.card.switchToThisServer })
    switchButtons.forEach(b => expect(b).toBeDisabled())
    switchButtons.forEach(b => fireEvent.click(b))
    expect(activate).not.toHaveBeenCalled()

    const startButtons = screen.getAllByRole('button', { name: en.card.start })
    expect(startButtons.length).toBeGreaterThan(0)
    startButtons.forEach(b => expect(b).toBeDisabled())
    startButtons.forEach(b => fireEvent.click(b))
    await waitFor(() => expect(activate).not.toHaveBeenCalled())

    const restartButton = await screen.findByRole('button', { name: /restart docker-b/i })
    expect(restartButton).toBeDisabled()
    fireEvent.click(restartButton)
    expect(dockerRunAction).not.toHaveBeenCalled()

    await waitFor(() => expect(discoverMounts).toHaveBeenCalled())
    discoverMounts.mockClear()
    const scanButton = screen.getByRole('button', { name: en.pageHeader.scanAria })
    expect(scanButton).toBeDisabled()
    fireEvent.click(scanButton)
    expect(discoverMounts).not.toHaveBeenCalled()

    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
    await screen.findByRole('heading', { name: en.editDialog.title })
    const saveButton = screen.getByRole('button', { name: en.editDialog.saveChanges })
    expect(saveButton).toBeDisabled()
    fireEvent.click(saveButton)
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.editDialog.cancel }))

    const menu2 = await openCardMenu('server-a')
    fireEvent.click(within(menu2).getByRole('menuitem', { name: en.card.removeFromPanel }))
    await screen.findByRole('heading', { name: en.deleteDialog.title })
    const deleteFilesCheckbox = screen.getByRole('checkbox', { name: new RegExp(en.deleteDialog.alsoDeleteFilesLabel) })
    expect(deleteFilesCheckbox).toBeDisabled()
    const removeButton = screen.getByRole('button', { name: en.deleteDialog.removeFromPanel })
    expect(removeButton).toBeDisabled()
    fireEvent.click(removeButton)
    expect(del).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.deleteDialog.cancel }))

    await openSteamDialogForServerA()
    const startUpdateButton = screen.getByRole('button', { name: en.steamDialog.startUpdate })
    expect(startUpdateButton).toBeDisabled()
    fireEvent.click(startUpdateButton)
    expect(steamUpdate).not.toHaveBeenCalled()
    expect(steamVerify).not.toHaveBeenCalled()

    const clearFolderButton = screen.getByRole('button', { name: en.steamDialog.clearFolderButton })
    expect(clearFolderButton).toBeDisabled()
    fireEvent.click(clearFolderButton)
    expect(screen.queryByRole('heading', { name: en.clearInstallDialog.title })).not.toBeInTheDocument()
    expect(deleteFiles).not.toHaveBeenCalled()
  })

  it('enables every gated trigger once the role holds the matching capability', async () => {
    mockCan = () => true
    await setUpFixtures()
    getStatus.mockResolvedValue({
      servers: [{ id: '1', name: 'server-a', running: false, pid: null, isActive: false, stateUnknown: false }],
    } as never)
    renderServers()
    await screen.findByText('server-a')

    screen.getAllByRole('button', { name: en.card.switchToThisServer }).forEach(b => expect(b).not.toBeDisabled())
    screen.getAllByRole('button', { name: en.card.start }).forEach(b => expect(b).not.toBeDisabled())

    const restartButton = await screen.findByRole('button', { name: /restart docker-b/i })
    expect(restartButton).not.toBeDisabled()
    fireEvent.click(restartButton)
    await waitFor(() => expect(dockerRunAction).toHaveBeenCalledWith('docker-b', 'restart', 2))

    await waitFor(() => expect(discoverMounts).toHaveBeenCalled())
    discoverMounts.mockClear()
    const scanButton = screen.getByRole('button', { name: en.pageHeader.scanAria })
    expect(scanButton).not.toBeDisabled()
    fireEvent.click(scanButton)
    await waitFor(() => expect(discoverMounts).toHaveBeenCalledTimes(1))

    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
    await screen.findByRole('heading', { name: en.editDialog.title })
    expect(screen.getByRole('button', { name: en.editDialog.saveChanges })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: en.editDialog.saveChanges }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))

    const menu2 = await openCardMenu('server-a')
    fireEvent.click(within(menu2).getByRole('menuitem', { name: en.card.removeFromPanel }))
    await screen.findByRole('heading', { name: en.deleteDialog.title })
    expect(screen.getByRole('checkbox', { name: new RegExp(en.deleteDialog.alsoDeleteFilesLabel) })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: en.deleteDialog.removeFromPanel })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: en.deleteDialog.cancel }))

    await openSteamDialogForServerA()
    fireEvent.click(screen.getByRole('button', { name: en.steamDialog.clearFolderButton }))
    await screen.findByRole('heading', { name: en.clearInstallDialog.title })
    expect(screen.getByRole('button', { name: en.clearInstallDialog.clearFolder })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: en.clearInstallDialog.clearFolder }))
    await waitFor(() => expect(deleteFiles).toHaveBeenCalledTimes(1))

    expect(screen.getByRole('button', { name: en.steamDialog.startUpdate })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: en.steamDialog.startUpdate }))
    await waitFor(() => expect(steamUpdate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(deleteFiles).toHaveBeenCalledTimes(1))
  })

  it('ruling 1: inline Start/Stop stays unreachable holding only servers.manage, without server.control (partial-execution risk)', async () => {
    mockCan = (capability) => capability === 'servers.manage'
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    const startButtons = screen.getAllByRole('button', { name: en.card.start })
    startButtons.forEach(b => expect(b).toBeDisabled())
    startButtons.forEach(b => fireEvent.click(b))
    await waitFor(() => expect(activate).not.toHaveBeenCalled())
  })

  it('ruling 1: inline Start/Stop stays unreachable holding only server.control, without servers.manage', async () => {
    mockCan = (capability) => capability === 'server.control'
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    const startButtons = screen.getAllByRole('button', { name: en.card.start })
    startButtons.forEach(b => expect(b).toBeDisabled())
    startButtons.forEach(b => fireEvent.click(b))
    await waitFor(() => expect(activate).not.toHaveBeenCalled())
  })

  it('ruling 2: the delete-files checkbox is gated on server.wipe independently -- lacking it still allows the base panel-record delete', async () => {
    mockCan = (capability) => capability !== 'server.wipe'
    await setUpFixtures()
    renderServers()
    await screen.findByText('server-a')

    const menu = await openCardMenu('server-a')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.removeFromPanel }))
    await screen.findByRole('heading', { name: en.deleteDialog.title })

    const checkbox = screen.getByRole('checkbox', { name: new RegExp(en.deleteDialog.alsoDeleteFilesLabel) })
    expect(checkbox).toBeDisabled()

    const removeButton = screen.getByRole('button', { name: en.deleteDialog.removeFromPanel })
    expect(removeButton).not.toBeDisabled()
    fireEvent.click(removeButton)
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1))
    expect(deleteFiles).not.toHaveBeenCalled()
  })
})
