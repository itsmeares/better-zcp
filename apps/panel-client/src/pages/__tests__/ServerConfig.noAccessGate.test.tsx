import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from '@/lib/routerCompat'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'


let mockCan = (_capability: string) => false

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

const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
vi.spyOn(serversApi, 'getResolvedActive').mockResolvedValue({ server: null })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderServerConfig() {
  return render(
    <MemoryRouter>
      <ServerConfig />
    </MemoryRouter>,
  )
}

describe('ServerConfig.tsx: gates the whole page on serverfiles.manage, same can() idiom as Settings.tsx', () => {
  it('shows a restricted-access message and never fetches config data for a role without serverfiles.manage', async () => {
    mockCan = () => false

    renderServerConfig()

    expect(await screen.findByText("You don't have access to Server Configuration")).toBeInTheDocument()
    expect(screen.getByText(/Manage server files/)).toBeInTheDocument()
    expect(getPaths).not.toHaveBeenCalled()
  })

  it('proceeds to load config data for a role that HOLDS serverfiles.manage', async () => {
    mockCan = (capability) => capability === 'serverfiles.manage'
    getPaths.mockRejectedValue(new Error('network unavailable in test'))

    renderServerConfig()

    await waitFor(() => expect(getPaths).toHaveBeenCalled())
    expect(screen.queryByText("You don't have access to Server Configuration")).not.toBeInTheDocument()
  })
})
