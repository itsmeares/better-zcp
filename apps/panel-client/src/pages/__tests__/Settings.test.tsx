import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'

// conv-ia / god's ruling (Option A): a role without users.manage/roles.manage
// must not see the Users/Roles & Permissions tabs, and must not reach their
// panels by direct URL either (?tab=users on a bookmark, browser history,
// etc). The gate lives entirely client-side (AuthContext's can(), fed by an
// additive GET /api/auth/me "capabilities" field) and is UX only -- the real
// enforcement is requirePermission("users.manage"/"roles.manage") on the
// actual API routes, unchanged by this. This test proves the UX side: the
// tab list and the URL-driven tab selection both honor a denied capability.
//
// Settings.tsx's own data-fetching (configApi.getAppSettings(), backupApi,
// panelBridgeApi, etc -- ~10 unconditional-on-mount API calls) is left
// unmocked deliberately: none of it gates whether the Users/Roles tabs
// exist, and each has its own defensive catch/fallback already covered by
// the rest of the suite, so mocking all of it here would only test that
// those fallbacks still work, not the capability gate.
//
// bug-hunt-2026-08-26 (client-suite-flaky-one-in-six): the "shows both tabs"
// test below mutates this SHARED, module-level mock with
// can.mockImplementation(() => true) and nothing ever reset it back. Vitest
// runs a file's tests in declaration order by default, so with this test
// declared last it was invisible every normal run -- but `--sequence.shuffle`
// reordered it before its siblings and reproduced a real failure twice in
// three shuffled runs (two different sibling tests failed, matching whichever
// one happened to run after the mutating one): the "hides the tabs" and
// "does not render via ?tab=users" tests both wrongly saw every capability
// granted. Reset in beforeEach so every test starts from the same baseline
// regardless of execution order, instead of relying on declaration order to
// protect it by accident.
const denyUsersAndRolesCapability = (capability: string) =>
  capability !== 'users.manage' && capability !== 'roles.manage'
const can = vi.fn(denyUsersAndRolesCapability)

beforeEach(() => {
  can.mockImplementation(denyUsersAndRolesCapability)
})

// Only configApi.getAppSettings is mocked -- it's the one call that gates
// Settings.tsx's top-level `loading` state (the tab list doesn't render
// until it settles). Everything else Settings.tsx fetches on mount is left
// as the real implementation, which fails fast against jsdom's fetch and
// hits its own already-tested defensive fallback; none of it gates whether
// the Users/Roles tabs exist, which is the only thing this file is testing.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn().mockResolvedValue({ settings: {} }) },
    // Only needed for the "capability granted" case below, where Users.tsx
    // actually mounts and runs its own fetchAll() -- same shapes as
    // RolesPermissions.test.tsx's mocks for the same two calls.
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
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Settings -- Users/Roles tabs are gated on capability, not just decoration', () => {
  it('hides the Users and Roles & Permissions tab triggers when the role lacks both capabilities', async () => {
    renderSettings('/settings')

    // "General" (always visible) proves the tab list itself rendered, so an
    // absent Users/Roles trigger below means "gated", not "nothing rendered".
    expect(await screen.findByRole('tab', { name: 'General' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Roles & Permissions' })).not.toBeInTheDocument()
  })

  it('does not render the Users panel via a direct ?tab=users URL -- falls back instead of exposing it', async () => {
    renderSettings('/settings?tab=users')

    await screen.findByRole('tab', { name: 'General' })
    // Users.tsx's own action button -- present only if its panel actually
    // mounted. Falling back to "general" means it never does.
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
