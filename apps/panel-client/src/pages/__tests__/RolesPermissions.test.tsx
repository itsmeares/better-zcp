import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import RolesPermissions from '../RolesPermissions'
import { permissionsApi, usersApi, type CapabilityGroup, type RoleInfo } from '@/lib/api'

function renderRolesPermissions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RolesPermissions />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}


vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    permissionsApi: { ...actual.permissionsApi, getCapabilities: vi.fn(), getRoles: vi.fn(), updateRole: vi.fn() },
    usersApi: { ...actual.usersApi, list: vi.fn() },
  }
})

const getCapabilities = vi.mocked(permissionsApi.getCapabilities)
const getRoles = vi.mocked(permissionsApi.getRoles)
const updateRole = vi.mocked(permissionsApi.updateRole)
const listUsers = vi.mocked(usersApi.list)

const groups: CapabilityGroup[] = [
  {
    group: 'test',
    capabilities: [
      { key: 'alpha.cap', label: 'Alpha Capability', description: 'desc a' },
      { key: 'beta.cap', label: 'Beta Capability', description: 'desc b' },
    ],
  },
]

const role: RoleInfo = {
  id: 'role1',
  name: 'Test Role',
  capabilities: ['alpha.cap', 'beta.cap'],
  isSeeded: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  memberCount: 0,
}

beforeEach(() => {
  getCapabilities.mockReset().mockResolvedValue({ groups })
  getRoles.mockReset().mockResolvedValue({ roles: [role] })
  updateRole.mockReset()
  listUsers.mockReset().mockResolvedValue({ users: [] })
})

describe('RolesPermissions -- concurrent capability toggles on one role', () => {
  it('the second PATCH already omits whatever the first one just removed, not a stale snapshot', async () => {
    updateRole.mockImplementation(() => new Promise(() => {}))

    renderRolesPermissions()

    const alphaBox = await screen.findByRole('checkbox', { name: 'Test Role: Alpha Capability' })
    const betaBox = screen.getByRole('checkbox', { name: 'Test Role: Beta Capability' })
    expect(alphaBox).toHaveAttribute('data-state', 'checked')
    expect(betaBox).toHaveAttribute('data-state', 'checked')

    fireEvent.click(alphaBox)
    fireEvent.click(betaBox)

    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(2))

    const firstCallBody = updateRole.mock.calls[0][1]
    const secondCallBody = updateRole.mock.calls[1][1]
    expect(firstCallBody.capabilities).toEqual(['beta.cap'])
    expect(secondCallBody.capabilities).toEqual([])
  })

  it('both removals survive even when the responses resolve out of order', async () => {
    let resolveFirst: ((value: { role: RoleInfo }) => void) | null = null
    let resolveSecond: ((value: { role: RoleInfo }) => void) | null = null
    updateRole
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))

    renderRolesPermissions()

    const alphaBox = await screen.findByRole('checkbox', { name: 'Test Role: Alpha Capability' })
    const betaBox = screen.getByRole('checkbox', { name: 'Test Role: Beta Capability' })

    fireEvent.click(alphaBox)
    fireEvent.click(betaBox)
    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(2))

    resolveSecond!({ role: { ...role, capabilities: [] } })
    resolveFirst!({ role: { ...role, capabilities: ['beta.cap'] } })

    await waitFor(async () => {
      expect(await screen.findByRole('checkbox', { name: 'Test Role: Alpha Capability' })).toHaveAttribute(
        'data-state',
        'unchecked',
      )
      expect(await screen.findByRole('checkbox', { name: 'Test Role: Beta Capability' })).toHaveAttribute(
        'data-state',
        'unchecked',
      )
    })
  })
})
