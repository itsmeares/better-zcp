import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Templates from '../Templates'
import { templatesApi } from '@/lib/api'

// bug-hunt-2026-08-27: canManage used to be `!authEnabled || user?.role ===
// 'admin'` -- a hardcoded role literal where the server actually checks the
// templates.manage CAPABILITY (requirePermission("templates.manage") on
// POST/import/apply/delete in routes/templates.js). A default-seeded
// Technician role holds templates.manage and the server would honor it, but
// the old check hid every manage control from them anyway because their
// role string wasn't literally "admin". This pins the fix: a non-admin role
// WITH the capability now sees the manage controls, and a role without it
// still doesn't.

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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    templatesApi: { ...actual.templatesApi, list: vi.fn() },
  }
})

const listTemplates = vi.mocked(templatesApi.list)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderTemplates() {
  return render(
    <MemoryRouter>
      <Templates />
    </MemoryRouter>,
  )
}

describe('Templates.tsx canManage: gates on the templates.manage capability, not a role literal', () => {
  it('shows the manage controls for a non-admin role that HOLDS templates.manage', async () => {
    mockCan = (capability) => capability === 'templates.manage'
    listTemplates.mockResolvedValue({ templates: [] })

    renderTemplates()

    expect(await screen.findByRole('button', { name: 'Save Current Config' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument()
  })

  it('hides the manage controls for a non-admin role that lacks templates.manage', async () => {
    mockCan = () => false
    listTemplates.mockResolvedValue({ templates: [] })

    renderTemplates()

    await screen.findByText('Simulation Templates')
    expect(screen.queryByRole('button', { name: 'Save Current Config' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
  })

  it('renders the empty state when the template list payload is missing its array', async () => {
    mockCan = () => false
    listTemplates.mockResolvedValue({ templates: undefined as unknown as SimTemplate[] })

    renderTemplates()

    expect(await screen.findByText('No templates yet')).toBeInTheDocument()
  })
})
