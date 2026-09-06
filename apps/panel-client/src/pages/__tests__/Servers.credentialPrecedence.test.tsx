import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// bug-hunt-2026-08-26: god flagged that Servers.tsx's Add Existing Server
// form has an invisible credential-precedence rule -- manual RCON password
// entry always wins over an auto-detected INI import -- with nothing in the
// code shape enforcing it and zero test coverage on the page at all. Traced
// the actual mechanism (Servers.tsx, "Add Existing Server" -> local mode):
//
//   - handleSelectServerConfig()/handleDetectServer() set `importIniFrom` to
//     a {dataPath, serverName} REFERENCE (never the password itself -- the
//     detect/auto-scan endpoints don't return it) whenever the detected INI
//     has an RCON password configured (hasRcon).
//   - Typing into the RCON password field clears importIniFrom immediately
//     (any keystroke, not just a non-empty one) -- UI-level "manual wins".
//   - Independently, at submit time: `useIniImport = addMode === 'local' &&
//     !!importIniFrom && !newServer.rconPassword.trim()`, and the payload
//     spreads EITHER `{importIniFrom}` OR `{rconPassword}` -- never both,
//     and `rconPassword` is entirely ABSENT from the request when importing
//     (not sent as ''). This is the real security boundary: even if the
//     UI-level clearing above were ever broken, this second, independent
//     check at the network-request boundary is what actually decides which
//     credential reaches the server -- so this suite pins the SUBMITTED
//     PAYLOAD, not just the intermediate state.
//
// No rule found here looked wrong -- both the UI-level and submit-level
// checks default to requiring a real password (fail closed) when no import
// is available, and there is no path that sends both credentials or an
// empty rconPassword string. Confirmed with god before writing (see reply
// to 2026-08-27T04-52-25-949Z-bf9c01): pinning behaviour, not chasing
// coverage, so only the credential-precedence rule and its immediate
// siblings (import unavailable -> manual entry required) are covered here.
//
// Follow-up (2026-08-27T05-03-43-634Z-098280): the manual-detect path
// (handleSelectServerConfig) showed a destructive "RCON not configured"
// toast when the selected config has no RCON password; the auto-scan path
// (handleSelectScannedConfig) did not, even though the underlying
// required-password/disabled logic is identical on both paths -- a missing
// notification, not a missing guard, so no security behaviour changes here.
// Added the same toast (verbatim copy, reused rather than re-written) to
// the auto-scan path and pinned it below.

// bug-hunt-2026-08-27 (Tier 3 gating sweep): Servers.tsx never called
// useAuth() before this sweep, so this suite never needed an AuthProvider.
// Adding capability gating makes it throw outside one -- can() fails open
// (true) here since this file's assertions are about credential precedence,
// not capability gating (that's Servers.capabilityGating.test.tsx).
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

// One existing, inactive server -- keeps the page out of its empty-state
// onboarding view, which renders a second "Add Existing Server" button with
// the same accessible name as the one in the page header.
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

  // Only one server was detected, so it is auto-selected and importIniFrom
  // is set without any further click -- this text is the operator-visible
  // proof that an import is on offer.
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

    // UI-visible side of the same rule: the "will import" hint is gone and
    // the ordinary "password set" confirmation takes its place.
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

    // No import is on offer -- the "will import" hint never appears, and Add
    // Server stays disabled until a real password is typed.
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

    // Same condition, same operator-facing copy as the manual-detect path --
    // reused verbatim rather than a second message for the same thing.
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
