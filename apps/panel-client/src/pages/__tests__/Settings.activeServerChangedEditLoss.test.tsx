import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from '@/lib/routerCompat'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, serversApi } from '@/lib/api'


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
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
  }
})

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getAllServers = vi.mocked(serversApi.getAll)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderSettings() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Settings.tsx: activeServerChanged respects unsaved edits, refreshes the servers list either way', () => {
  it('clean (no unsaved edits): both fetchServers and fetchSettings run again', async () => {
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    getAllServers.mockResolvedValue({ servers: [] })

    renderSettings()
    await waitFor(() => expect(getAppSettings).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await waitFor(() => expect(getAllServers).toHaveBeenCalledTimes(1), { timeout: 2000 })

    emitActiveServerChanged()

    await waitFor(() => expect(getAllServers).toHaveBeenCalledTimes(2), { timeout: 2000 })
    await waitFor(() => expect(getAppSettings).toHaveBeenCalledTimes(2), { timeout: 2000 })
  })

  it('dirty (unsaved edit in progress): fetchServers runs again, fetchSettings does NOT -- the typed value survives', async () => {
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    getAllServers.mockResolvedValue({ servers: [] })

    renderSettings()
    await waitFor(() => expect(getAppSettings).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await waitFor(() => expect(getAllServers).toHaveBeenCalledTimes(1), { timeout: 2000 })

    const portInput = await screen.findByRole('spinbutton') as HTMLInputElement
    fireEvent.change(portInput, { target: { value: '9999' } })
    expect(portInput.value).toBe('9999')

    emitActiveServerChanged()

    await waitFor(() => expect(getAllServers).toHaveBeenCalledTimes(2), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(getAppSettings).toHaveBeenCalledTimes(1)
    expect(portInput.value).toBe('9999')
  })
})
