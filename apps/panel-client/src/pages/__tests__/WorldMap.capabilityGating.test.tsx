import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'


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
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    mapApi: { ...actual.mapApi, resolve: vi.fn(), vehicles: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getServerInfo: vi.fn(),
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getUpdateStatus = vi.mocked(updateApi.getStatus)
const mapResolve = vi.mocked(mapApi.resolve)
const mapVehicles = vi.mocked(mapApi.vehicles)
const getServerInfo = vi.mocked(panelBridgeApi.getServerInfo)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)

const testServer: ServerInstance = {
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

class StubResizeObserver {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe() {
    this.cb(
      [{ contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderWorldMap() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <SocketContext.Provider value={null}>
          <WorldMap />
        </SocketContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUp(players: Array<{ name: string; x: number; y: number }>) {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  getResolvedActive.mockResolvedValue({ server: testServer })
  getUpdateStatus.mockResolvedValue({} as Awaited<ReturnType<typeof updateApi.getStatus>>)
  mapResolve.mockResolvedValue({
    root: '/tiles',
    b42Dir: 'b42',
    b41Path: '/tiles/b41',
    tileSize: 1024,
    width: 1157312,
    height: 509520,
    maxLevel: 21,
    renderedMaxLevel: 10,
  })
  mapVehicles.mockResolvedValue({ vehicles: [] })
  getServerInfo.mockResolvedValue({ success: true, data: { players } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>)
  getBridgeStatus.mockResolvedValue({ modConnected: true, modStatus: { version: '1.7.40' } } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  sendCommand.mockResolvedValue({ success: true, data: {} } as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
}

describe('WorldMap.tsx: healPlayer/setGodMode require players.gm_tools ALONE (2026-08-27 decision reverses c3083d5)', () => {
  it('stops vehicle detail polling when the vehicle layer is hidden but keeps safehouse polling', async () => {
    await setUp([])
    renderWorldMap()

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('getVehiclesDetailed'))
    const hideVehicles = await screen.findByRole('button', { name: /Hide vehicles/i })
    sendCommand.mockClear()
    mapVehicles.mockClear()

    fireEvent.click(hideVehicles)

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('getSafehouses'))
    expect(sendCommand).not.toHaveBeenCalledWith('getVehiclesDetailed')
    expect(mapVehicles).not.toHaveBeenCalled()
  })

  it('disables the dossier Heal and God buttons, and clicking them never calls the API, when the role lacks players.gm_tools even while holding bridge.command', async () => {
    mockCan = (capability) => capability !== 'players.gm_tools'
    await setUp([{ name: 'Kate', x: 10000, y: 10000 }])

    renderWorldMap()

    const rosterButton = await screen.findByRole('button', { name: /pan to kate/i })
    fireEvent.click(rosterButton)

    const healButton = await screen.findByRole('button', { name: 'Heal' })
    const godButton = screen.getByRole('button', { name: 'God' })
    expect(healButton).toBeDisabled()
    expect(godButton).toBeDisabled()

    fireEvent.click(healButton)
    fireEvent.click(godButton)

    await waitFor(() => {
      expect(sendCommand).not.toHaveBeenCalledWith('healPlayer', expect.anything())
      expect(sendCommand).not.toHaveBeenCalledWith('setGodMode', expect.anything())
    })
  })

  it('leaves an unrelated bridge.command-only action (Custom drop… on the empty-space menu) reachable under the same role -- proves the gm_tools gate on Heal/God is not an over-gate', async () => {
    mockCan = (capability) => capability !== 'players.gm_tools'
    await setUp([])

    renderWorldMap()

    await waitFor(() => expect(getBridgeStatus).toHaveBeenCalled())

    const canvas = await screen.findByRole('img', { name: /world map/i })
    fireEvent.contextMenu(canvas, { clientX: 10, clientY: 10 })

    const customDrop = await screen.findByRole('menuitem', { name: /custom drop/i })
    expect(customDrop).not.toBeDisabled()
  })

  it('enables the dossier Heal and God buttons, and Heal actually calls healPlayer, when the role holds players.gm_tools WITHOUT bridge.command -- the Technician case this ruling exists for', async () => {
    mockCan = (capability) => capability !== 'bridge.command'
    await setUp([{ name: 'Kate', x: 10000, y: 10000 }])

    renderWorldMap()

    const rosterButton = await screen.findByRole('button', { name: /pan to kate/i })
    fireEvent.click(rosterButton)

    const healButton = await screen.findByRole('button', { name: 'Heal' })
    const godButton = screen.getByRole('button', { name: 'God' })
    expect(healButton).not.toBeDisabled()
    expect(godButton).not.toBeDisabled()

    fireEvent.click(healButton)

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('healPlayer', { username: 'Kate' }))
  })
})
