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
const detect = vi.mocked(serversDetectApi.detect)
const autoScan = vi.mocked(serversDetectApi.autoScan)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

const EXISTING_SERVER = {
  id: 1,
  name: 'existing-server',
  serverName: 'existing-server',
  installPath: '/srv/existing',
  zomboidDataPath: '/srv/existing/data',
  serverConfigPath: '/srv/existing/data/Server/existing-server.ini',
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

async function openAddExistingServerDialog() {
  fireEvent.click(await screen.findByRole('button', { name: en.pageHeader.addExisting }))
  await screen.findByRole('heading', { name: en.addDialog.titleLocal })
}

async function detectSingleServerWithRcon() {
  detect.mockResolvedValue({
    valid: true,
    dataPath: '/srv/detected/data',
    serverConfigPath: '/srv/detected/data/Server/detected.ini',
    installPath: '/srv/detected',
    validInstallPath: true,
    hasNoSteam: false,
    detectedServers: [
      { serverName: 'detected', iniFile: 'detected.ini', rconPort: 27015, serverPort: 16261, publicName: 'Detected Server', hasRcon: true },
    ],
  } as never)

  fireEvent.change(screen.getByPlaceholderText(en.localForm.dataPathPlaceholder), {
    target: { value: '/srv/detected/data' },
  })
  fireEvent.click(screen.getByRole('button', { name: en.localForm.detect }))

  await screen.findByText(en.localForm.passwordWillImport.split('{{')[0], { exact: false })
}

beforeEach(() => {
  getAll.mockReset().mockResolvedValue({ servers: [EXISTING_SERVER] } as never)
  getStatus.mockReset().mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockReset().mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockReset().mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockReset().mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  getAppSettings.mockReset().mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockReset().mockResolvedValue({} as never)
  detect.mockReset()
  autoScan.mockReset()
  create.mockReset().mockResolvedValue({ server: { id: 2 } } as never)
  activate.mockReset().mockResolvedValue({} as never)
  toastSpy.mockClear()
})

describe('Servers -- Add Existing Server credential precedence (manual entry always wins over an INI import)', () => {
  it('sends the typed password and omits importIniFrom once the operator types a manual password', async () => {
    renderServers()
    await openAddExistingServerDialog()
    await detectSingleServerWithRcon()

    fireEvent.change(screen.getByPlaceholderText(en.localForm.rconPasswordImportPlaceholder), {
      target: { value: 'my-typed-password' },
    })

    expect(screen.queryByText(en.localForm.passwordWillImport.split('{{')[0], { exact: false })).not.toBeInTheDocument()
    await screen.findByText(en.localForm.passwordSet)

    fireEvent.click(screen.getByRole('button', { name: en.addDialog.addServer }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const payload = create.mock.calls[0][0] as Record<string, unknown>
    expect(payload.rconPassword).toBe('my-typed-password')
    expect(payload).not.toHaveProperty('importIniFrom')
  })

  it('sends importIniFrom and omits rconPassword entirely when the operator leaves the password blank', async () => {
    renderServers()
    await openAddExistingServerDialog()
    await detectSingleServerWithRcon()

    fireEvent.click(screen.getByRole('button', { name: en.addDialog.addServer }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const payload = create.mock.calls[0][0] as Record<string, unknown>
    expect(payload.importIniFrom).toEqual({ dataPath: '/srv/detected/data', serverName: 'detected' })
    expect(payload).not.toHaveProperty('rconPassword')
  })

  it('blocks submission on a manual password when the detected config has no RCON password to import', async () => {
    renderServers()
    await openAddExistingServerDialog()

    detect.mockResolvedValue({
      valid: true,
      dataPath: '/srv/norcon/data',
      serverConfigPath: '/srv/norcon/data/Server/norcon.ini',
      installPath: '/srv/norcon',
      validInstallPath: true,
      hasNoSteam: false,
      detectedServers: [
        { serverName: 'norcon', iniFile: 'norcon.ini', rconPort: 27015, serverPort: 16261, publicName: 'No RCON Server', hasRcon: false },
      ],
    } as never)

    fireEvent.change(screen.getByPlaceholderText(en.localForm.dataPathPlaceholder), {
      target: { value: '/srv/norcon/data' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.localForm.detect }))

    await screen.findByPlaceholderText(en.localForm.rconPasswordPlaceholder)
    expect(screen.queryByText(en.localForm.passwordWillImport.split('{{')[0], { exact: false })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: en.addDialog.addServer })).toBeDisabled())

    fireEvent.change(screen.getByPlaceholderText(en.localForm.rconPasswordPlaceholder), {
      target: { value: 'a-real-password' },
    })
    expect(screen.getByRole('button', { name: en.addDialog.addServer })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: en.addDialog.addServer }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const payload = create.mock.calls[0][0] as Record<string, unknown>
    expect(payload.rconPassword).toBe('a-real-password')
    expect(payload).not.toHaveProperty('importIniFrom')
  })

  it('warns on the manual-detect path when the detected config has no RCON password', async () => {
    renderServers()
    await openAddExistingServerDialog()

    detect.mockResolvedValue({
      valid: true,
      dataPath: '/srv/norcon/data',
      serverConfigPath: '/srv/norcon/data/Server/norcon.ini',
      installPath: '/srv/norcon',
      validInstallPath: true,
      hasNoSteam: false,
      detectedServers: [
        { serverName: 'norcon', iniFile: 'norcon.ini', rconPort: 27015, serverPort: 16261, publicName: 'No RCON Server', hasRcon: false },
      ],
    } as never)

    fireEvent.change(screen.getByPlaceholderText(en.localForm.dataPathPlaceholder), {
      target: { value: '/srv/norcon/data' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.localForm.detect }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: en.toasts.rconNotConfiguredTitle,
          description: en.toasts.rconNotConfiguredDesc,
          variant: 'destructive',
        }),
      ),
    )
  })

  it('warns on the auto-scan path too, with the identical toast, when the scanned config has no RCON password', async () => {
    renderServers()
    await openAddExistingServerDialog()

    fireEvent.click(screen.getByRole('button', { name: en.localForm.autoScan }))
    fireEvent.change(screen.getByPlaceholderText(en.localForm.scanPathPlaceholder), {
      target: { value: '/srv/scan-root' },
    })

    autoScan.mockResolvedValue({
      scanPath: '/srv/scan-root',
      installPaths: ['/srv/scan-root/install'],
      dataPaths: ['/srv/scan-root/data'],
      customBatFiles: [],
      detectedConfigs: [
        {
          dataPath: '/srv/scan-root/data',
          serverConfigPath: '/srv/scan-root/data/Server/norcon.ini',
          dockerContainerName: '',
          serverName: 'norcon',
          iniFile: 'norcon.ini',
          rconPort: 27015,
          serverPort: 16261,
          publicName: 'No RCON Scanned Server',
          hasRcon: false,
        },
      ],
    } as never)

    fireEvent.click(screen.getByRole('button', { name: en.localForm.scan }))

    const configButtonName = en.localForm.selectScannedConfigAria.replace('{{name}}', 'No RCON Scanned Server')
    fireEvent.click(await screen.findByRole('button', { name: configButtonName }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: en.toasts.rconNotConfiguredTitle,
          description: en.toasts.rconNotConfiguredDesc,
          variant: 'destructive',
        }),
      ),
    )
  })
})
