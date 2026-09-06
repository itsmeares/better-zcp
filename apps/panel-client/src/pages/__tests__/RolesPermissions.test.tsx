import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import RolesPermissions from '../RolesPermissions'
import { permissionsApi, usersApi, type CapabilityGroup, type RoleInfo } from '@/lib/api'

// impeccable-2026-08-31: capability rows now carry a HelpTip (Radix Tooltip)
// for the description text that used to render permanently -- Tooltip
// throws if it's not inside a TooltipProvider, same requirement every other
// HelpTip-rendering page's tests already wrap for (see Settings.test.tsx).
function renderRolesPermissions() {
  return render(
    <TooltipProvider>
      <RolesPermissions />
    </TooltipProvider>,
  )
}

// conv-bugfix2 / god's authorization: two capability toggles on the same
// role fired before the first one's response re-renders `roles` used to
// both compute nextCapabilities from the same stale role.capabilities
// snapshot. The server's updateRole() is a hard replace, not a merge, so
// whichever request the client happened to build second silently omitted
// whatever the first request had just removed -- a revoked capability could
// come back with no error, no toast, nothing to indicate it happened.

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
    // Both calls stay pending so the component's `roles` state never
    // re-renders between the two clicks -- the exact race window.
    updateRole.mockImplementation(() => new Promise(() => {}))

    renderRolesPermissions()

    const alphaBox = await screen.findByRole('checkbox', { name: 'Test Role: Alpha Capability' })
    const betaBox = screen.getByRole('checkbox', { name: 'Test Role: Beta Capability' })
    expect(alphaBox).toHaveAttribute('data-state', 'checked')
    expect(betaBox).toHaveAttribute('data-state', 'checked')

    // Uncheck alpha, then uncheck beta before alpha's response ever lands.
    fireEvent.click(alphaBox)
    fireEvent.click(betaBox)

    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(2))

    const firstCallBody = updateRole.mock.calls[0][1]
    const secondCallBody = updateRole.mock.calls[1][1]
    expect(firstCallBody.capabilities).toEqual(['beta.cap'])
    // This is the assertion that fails without the fix: the buggy code
    // derives the second request from the still-stale role.capabilities
    // closure (which still contains 'alpha.cap' since the first request
    // never resolved), so it would submit ['alpha.cap'] here instead of [].
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

    // While both requests are in flight the cells render a spinner, not the
    // checkbox -- so both checkboxes are briefly absent from the DOM here.
    // Resolve the SECOND request first, then the first -- the exact
    // out-of-order landing god described ("it lands second and wins").
    // The first response's own payload (['beta.cap']) reflects only what
    // request 1 knew about at send time -- correct request construction,
    // but stale relative to request 2's already-applied result.
    resolveSecond!({ role: { ...role, capabilities: [] } })
    resolveFirst!({ role: { ...role, capabilities: ['beta.cap'] } })

    // Re-query rather than reuse the pre-click references -- React swaps
    // the checkbox for a spinner element while its cell is busy, so the
    // original node is detached from the tree once a click has fired.
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
