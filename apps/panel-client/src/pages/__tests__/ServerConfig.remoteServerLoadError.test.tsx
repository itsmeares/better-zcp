import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from '@/test/router'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi, ApiError } from '@/lib/api'


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

const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')

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

describe('ServerConfig.tsx: active-server-is-remote load-error messaging', () => {
  it('shows the remote-config copy and the real server name instead of "No active server configured" / "No server selected"', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Tour Remote Server', serverName: 'servertest', isRemote: true } as never,
    })
    getPaths.mockRejectedValue(
      new ApiError('No active server configured', { status: 404, code: 'SERVER_NOT_CONFIGURED' }),
    )

    renderServerConfig()

    expect(await screen.findByText(/This server is remote\. Add its SFTP details/)).toBeInTheDocument()
    expect(screen.queryByText('No active server configured')).not.toBeInTheDocument()
    expect(screen.queryByText('No server selected')).not.toBeInTheDocument()
    expect(screen.getByText('Tour Remote Server')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('does not also claim the Settings/Sandbox tab files are missing for the same remote-no-SFTP condition', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Tour Remote Server', serverName: 'servertest', isRemote: true } as never,
    })
    getPaths.mockRejectedValue(
      new ApiError('No active server configured', { status: 404, code: 'SERVER_NOT_CONFIGURED' }),
    )

    renderServerConfig()

    await screen.findByText(/This server is remote\. Add its SFTP details/)
    expect(screen.queryByLabelText('file missing')).not.toBeInTheDocument()
  })

  it('does not also fire a destructive "Error" toast for the same remote-no-SFTP condition the banner already explains', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Tour Remote Server', serverName: 'servertest', isRemote: true } as never,
    })
    getPaths.mockRejectedValue(
      new ApiError('No active server configured', { status: 404, code: 'SERVER_NOT_CONFIGURED' }),
    )

    renderServerConfig()

    await screen.findByText(/This server is remote\. Add its SFTP details/)
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('still shows the generic load-error copy with a Retry button for a real, non-remote failure', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 2, name: 'Ashenwood', serverName: 'Ashenwood', isRemote: false } as never,
    })
    getPaths.mockRejectedValue(new ApiError('boom', { status: 500 }))

    renderServerConfig()

    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByText(/This server is remote\. Add its SFTP details/)).not.toBeInTheDocument()
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }))
  })

  it('leaves the page exactly as before when there is genuinely no active server at all', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getPaths.mockRejectedValue(
      new ApiError('No active server configured', { status: 404, code: 'SERVER_NOT_CONFIGURED' }),
    )

    renderServerConfig()

    expect(await screen.findByText('No active server configured')).toBeInTheDocument()
    expect(screen.getByText('No server selected')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.getAllByLabelText('file missing').length).toBeGreaterThan(0)
  })
})
