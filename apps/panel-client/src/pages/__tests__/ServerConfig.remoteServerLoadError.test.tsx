import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi, ApiError } from '@/lib/api'

// 2026-08-31 regression finding: apps/panel-server/routes/serverFiles.js's
// getServerConfigPath() throws the SAME SERVER_NOT_CONFIGURED error for a
// genuinely-unconfigured panel AND for an active REMOTE server with no SFTP
// transport configured -- the isRemote branch falls through to the same
// "nothing configured" throw when transport resolution comes back empty,
// instead of the router's own second-stage REMOTE_CONFIG_NOT_CONFIGURED
// gate (which never runs, because the first gate already threw). The wire
// error code alone can't tell the two conditions apart, so the client reads
// the active server independently (serversApi.getResolvedActive(), same
// pattern as Backups.tsx) and overrides the message when it already knows
// better than to trust the server's "no active server" claim -- proven
// wrong by the sidebar showing the very server the page would otherwise
// claim doesn't exist.

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
    // Retry can't turn a remote server into a local one or add SFTP
    // details on its own, so it should not be offered for this condition.
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  // regression: the Settings/Sandbox tab badges independently read
  // pathsInfo?.exists.{ini,sandbox} to decide whether to show a "file
  // missing" warning icon -- pathsInfo is null here for the SAME reason the
  // banner above exists (nothing was confirmed missing, the remote host was
  // just unreachable without SFTP transport), so before this fix both tabs
  // showed "file missing" right next to a banner already explaining the
  // real reason, and next to a sidebar naming this same server as REMOTE.
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

  // impeccable-2026-08-31: the banner above renders with warning styling and
  // no Retry button specifically because this is a setup step, not a
  // failure -- a destructive-styled "Error" toast firing alongside it said
  // the opposite of what the banner deliberately chose not to say, and
  // repeated the exact same sentence a second time on screen.
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
    // Positive control for the test above: a genuine, non-remote failure is
    // still a one-off worth an immediate toast, not just the retry-able
    // banner -- confirms the new guard is scoped to the remote case only.
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
    // Positive control for the test above: a genuinely-unconfigured panel
    // (not remote) still gets the "file missing" badges -- confirms the new
    // !activeServerRemote guard is scoped to the remote case specifically,
    // not a blanket suppression of the badge.
    expect(screen.getAllByLabelText('file missing').length).toBeGreaterThan(0)
  })
})
