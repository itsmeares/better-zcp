import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// 2026-08-30 panelbridge-audit follow-up: MapPlayer/RawBridgePlayer already
// typed and threaded hunger/thirst/fatigue through WorldMap's state, and
// getServerInfo now actually sends them (fixed alongside this in
// PanelBridge.lua's handlers.getServerInfo), but nothing ever rendered
// them -- the dossier card jumped straight from the HP bar to the role
// line. Proves the values that make it across the wire are now visible in
// the dossier, and that a player the bridge sends no stats for (older
// bridge, or a player whose Stats object couldn't be read) doesn't show
// broken/placeholder bars for them.

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

async function setUp(players: Array<Record<string, unknown>>) {
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

describe('WorldMap.tsx dossier: hunger/thirst/fatigue from getServerInfo are actually rendered', () => {
  it('shows the real percentages for a player the bridge sent stats for', async () => {
    await setUp([{ name: 'Kate', x: 10000, y: 10000, hunger: 0.62, thirst: 0.18, fatigue: 0.4 }])

    renderWorldMap()

    const rosterButton = await screen.findByRole('button', { name: /pan to kate/i })
    fireEvent.click(rosterButton)

    await waitFor(() => {
      expect(screen.getByText('62%')).toBeInTheDocument()
      expect(screen.getByText('18%')).toBeInTheDocument()
      expect(screen.getByText('40%')).toBeInTheDocument()
    })
  })

  it('opens the dossier when the player marker itself is clicked', async () => {
    await setUp([{ name: 'Kate', x: 10000, y: 10000, health: 82 }])

    renderWorldMap()

    const canvas = await screen.findByRole('img', { name: /world map/i })
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    fireEvent.mouseDown(canvas, { button: 0, clientX: 400, clientY: 300 })
    fireEvent.mouseUp(canvas, { button: 0, clientX: 400, clientY: 300 })

    expect(await screen.findByRole('button', { name: 'Heal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'God' })).toBeInTheDocument()
    expect(screen.getAllByText('Kate')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Open player controls' })).toHaveAttribute('href', '/players?player=Kate')
  })

  it('opens the dossier when the player marker is tapped without panning', async () => {
    await setUp([{ name: 'Kate', x: 10000, y: 10000 }])

    renderWorldMap()

    const canvas = await screen.findByRole('img', { name: /world map/i })
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    fireEvent.touchStart(canvas, {
      touches: [{ clientX: 400, clientY: 300 }],
    })
    fireEvent.touchEnd(canvas, {
      touches: [],
      changedTouches: [{ clientX: 400, clientY: 300 }],
    })

    expect(await screen.findByRole('button', { name: 'Heal' })).toBeInTheDocument()
  })

  it('shows no stat bars at all for a player the bridge sent no stats for (older bridge / unreadable Stats object)', async () => {
    await setUp([{ name: 'Kate', x: 10000, y: 10000 }])

    renderWorldMap()

    const rosterButton = await screen.findByRole('button', { name: /pan to kate/i })
    fireEvent.click(rosterButton)

    await screen.findByRole('button', { name: 'Heal' })
    expect(screen.queryByText('hunger')).not.toBeInTheDocument()
    expect(screen.queryByText('thirst')).not.toBeInTheDocument()
    expect(screen.queryByText('fatigue')).not.toBeInTheDocument()
  })
})
