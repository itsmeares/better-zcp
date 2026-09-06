import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'

// regression: proving the client-capability-gating pattern (the
// same can() idiom Settings.tsx already uses to hide whole tabs) on a
// ROUTINE, non-destructive capability -- serverfiles.manage -- rather than
// a rare/destructive one, per the severity judgement from the sweep: a
// narrowly-scoped custom role ("config editor") would hit this page daily,
// and today it shows full, unrestricted editing UI regardless of whether
// the server will actually honor a save. apps/panel-server/routes/serverFiles.js
// gates its ENTIRE router (reads included, router.use(requirePermission(
// "serverfiles.manage"))) on this one capability, so a page-level gate is
// the correct grain -- there is no partial-access tier to preserve.

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
// ServerConfig.tsx's loadData() also resolves the active server independently
// (2026-08-31 remote-server-messaging fix) -- stub it so this test's real
// point (the capability gate) doesn't pay for three real, unmocked
// fetchWithRetry attempts against a server that isn't running.
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
