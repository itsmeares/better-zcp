import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from '@/test/router'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'

const denyUsersAndRolesCapability = (capability: string) =>
  capability !== 'users.manage' && capability !== 'roles.manage'
const can = vi.fn(denyUsersAndRolesCapability)

beforeEach(() => {
  can.mockImplementation(denyUsersAndRolesCapability)
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn().mockResolvedValue({ settings: {} }) },
    usersApi: { ...actual.usersApi, list: vi.fn().mockResolvedValue({ users: [] }) },
    permissionsApi: { ...actual.permissionsApi, getRoles: vi.fn().mockResolvedValue({ roles: [] }) },
  }
})

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'mod', role: 'moderator', capabilities: ['some.other.capability'] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can,
  }),
}))

function renderSettings(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })

  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('Settings -- Users/Roles tabs are gated on capability, not just decoration', () => {
  it('hides the Users and Roles & Permissions tab triggers when the role lacks both capabilities', async () => {
    renderSettings('/settings')

    expect(await screen.findByRole('tab', { name: 'General' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Roles & Permissions' })).not.toBeInTheDocument()
  })

  it('does not render the Users panel via a direct ?tab=users URL -- falls back instead of exposing it', async () => {
    renderSettings('/settings?tab=users')

    await screen.findByRole('tab', { name: 'General' })
    expect(screen.queryByRole('button', { name: /add user/i })).not.toBeInTheDocument()
  })

  it('does not render the Roles & Permissions panel via a direct ?tab=roles URL', async () => {
    renderSettings('/settings?tab=roles')

    await screen.findByRole('tab', { name: 'General' })
    expect(screen.queryByRole('button', { name: /new role/i })).not.toBeInTheDocument()
  })

  it('shows both tabs and renders their panels once the role holds the capabilities', async () => {
    can.mockImplementation(() => true)
    renderSettings('/settings?tab=users')

    expect(await screen.findByRole('tab', { name: 'Users' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Roles & Permissions' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /add user/i })).toBeInTheDocument()
  })
})
