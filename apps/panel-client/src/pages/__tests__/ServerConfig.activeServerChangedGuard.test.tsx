import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from '@/lib/routerCompat'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'


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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    on: (event: string, handler: () => void) => {
      if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
      socketHandlers.get(event)!.add(handler)
    },
    off: (event: string, handler: () => void) => {
      socketHandlers.get(event)?.delete(handler)
    },
  }),
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const saveIni = vi.spyOn(serverFilesApi, 'saveIni')
const getRaw = vi.spyOn(serverFilesApi, 'getRaw')
const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')

const emptyPaths = {
  exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
} as never

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderServerConfig() {
  return render(
    <MemoryRouter>
      <ServerConfig />
    </MemoryRouter>,
  )
}

describe('ServerConfig.tsx: activeServerChanged guards the cross-server overwrite', () => {
  it('reloads from the new active server when nothing is unsaved (matches every other page)', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    getPaths.mockResolvedValue(emptyPaths)
    getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
    getActive.mockResolvedValue({ server: null } as never)

    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))

    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/Active server changed/i)).not.toBeInTheDocument()
  })

  it('blocks Save and warns instead of silently overwriting the new active server when there are unsaved edits', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    getPaths.mockResolvedValue(emptyPaths)
    getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
    getActive.mockResolvedValue({ server: null } as never)
    getRaw.mockResolvedValue({ content: 'PVP=false' } as never)

    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))

    const rawToggles = await screen.findAllByRole('button', { name: /raw/i })
    await act(async () => { fireEvent.click(rawToggles[0]) })
    await waitFor(() => expect(getRaw).toHaveBeenCalled())
    const textarea = await screen.findByRole('textbox')
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'PVP=true\nedited=true' } })
    })

    act(() => { emitActiveServerChanged() })

    expect(await screen.findByText('Active server changed')).toBeInTheDocument()
    expect(getIni).toHaveBeenCalledTimes(1)

    const saveButtons = screen
      .getAllByRole('button', { name: /save/i })
      .filter((b) => !/saved configs/i.test(b.textContent || ''))
    expect(saveButtons.length).toBeGreaterThan(0)
    for (const btn of saveButtons) {
      expect(btn).toBeDisabled()
    }
    expect(saveIni).not.toHaveBeenCalled()
  })
})
