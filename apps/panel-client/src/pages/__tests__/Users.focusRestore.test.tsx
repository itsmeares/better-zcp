import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { MemoryRouter } from '@/test/router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Users from '../Users'
import { usersApi, permissionsApi, type ManagedUserAccount } from '@/lib/api'


vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    usersApi: { ...actual.usersApi, list: vi.fn(), remove: vi.fn(), create: vi.fn() },
    permissionsApi: { ...actual.permissionsApi, getRoles: vi.fn() },
  }
})

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'current-admin', username: 'admin', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

const listUsers = vi.mocked(usersApi.list)
const removeUser = vi.mocked(usersApi.remove)
const createUser = vi.mocked(usersApi.create)
const getRoles = vi.mocked(permissionsApi.getRoles)

function withQueryClient(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function makeUser(id: string, username: string): ManagedUserAccount {
  return { id, username, role: 'moderator', roleId: null, createdAt: '2026-01-01T00:00:00.000Z', lastLogin: null }
}

beforeEach(() => {
  getRoles.mockReset().mockResolvedValue({ roles: [] })
  listUsers.mockReset()
  removeUser.mockReset()
  createUser.mockReset()
})

async function confirmDelete(username: string) {
  const trigger = await screen.findByRole('button', { name: `Remove ${username}` })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove account' }))
}

describe('Users -- focus after a confirmed delete', () => {
  it('moves focus to the next row, not document.body, once the deleted row unmounts', async () => {
    const userA = makeUser('u1', 'alice')
    const userB = makeUser('u2', 'bob')
    listUsers.mockResolvedValue({ users: [userA, userB] })
    removeUser.mockResolvedValue({ success: true, user: { id: 'u1', username: 'alice' } })

    render(
      withQueryClient(
        <MemoryRouter>
          <ConfirmProvider>
            <Users />
          </ConfirmProvider>
        </MemoryRouter>,
      ),
    )

    await confirmDelete('alice')

    await waitFor(() => expect(removeUser).toHaveBeenCalledWith('u1'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove alice' })).not.toBeInTheDocument())

    const bobButton = screen.getByRole('button', { name: 'Remove bob' })
    await waitFor(() => expect(document.activeElement).toBe(bobButton))
  })

  it('moves focus to the previous row when the LAST row is deleted', async () => {
    const userA = makeUser('u1', 'alice')
    const userB = makeUser('u2', 'bob')
    listUsers.mockResolvedValue({ users: [userA, userB] })
    removeUser.mockResolvedValue({ success: true, user: { id: 'u2', username: 'bob' } })

    render(
      withQueryClient(
        <MemoryRouter>
          <ConfirmProvider>
            <Users />
          </ConfirmProvider>
        </MemoryRouter>,
      ),
    )

    await confirmDelete('bob')

    await waitFor(() => expect(removeUser).toHaveBeenCalledWith('u2'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove bob' })).not.toBeInTheDocument())

    const aliceButton = screen.getByRole('button', { name: 'Remove alice' })
    await waitFor(() => expect(document.activeElement).toBe(aliceButton))
  })

  it('falls back to the Add User button when the only row is deleted', async () => {
    const userA = makeUser('u1', 'alice')
    listUsers.mockResolvedValue({ users: [userA] })
    removeUser.mockResolvedValue({ success: true, user: { id: 'u1', username: 'alice' } })

    render(
      withQueryClient(
        <MemoryRouter>
          <ConfirmProvider>
            <Users />
          </ConfirmProvider>
        </MemoryRouter>,
      ),
    )

    await confirmDelete('alice')

    await waitFor(() => expect(removeUser).toHaveBeenCalledWith('u1'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove alice' })).not.toBeInTheDocument())

    const addUserButton = screen.getByRole('button', { name: /Add User/i })
    await waitFor(() => expect(document.activeElement).toBe(addUserButton))
  })

  it('does not move focus at all when the delete fails -- the row survives, and a later unrelated users-state change does not steal focus either', async () => {
    const userA = makeUser('u1', 'alice')
    const userB = makeUser('u2', 'bob')
    const userC = makeUser('u3', 'charlie')
    listUsers.mockResolvedValueOnce({ users: [userA, userB] })
    removeUser.mockRejectedValue(new Error('boom'))
    getRoles.mockReset().mockResolvedValue({ roles: [{ id: 'role-mod', name: 'moderator', capabilities: [] }] })
    createUser.mockResolvedValue({ success: true, user: userC })
    listUsers.mockResolvedValueOnce({ users: [userA, userB, userC] })

    render(
      withQueryClient(
        <MemoryRouter>
          <TooltipProvider>
            <ConfirmProvider>
              <Users />
            </ConfirmProvider>
          </TooltipProvider>
        </MemoryRouter>,
      ),
    )

    await confirmDelete('alice')

    await waitFor(() => expect(removeUser).toHaveBeenCalledWith('u1'))
    const aliceButtonStillThere = await screen.findByRole('button', { name: 'Remove alice' })
    expect(aliceButtonStillThere).toBeInTheDocument()

    await waitFor(() => expect(document.activeElement).toBe(aliceButtonStillThere))

    fireEvent.click(screen.getByRole('button', { name: /Add User/i }))
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'charlie' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'NewUserPassw0rd!7' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'NewUserPassw0rd!7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => expect(createUser).toHaveBeenCalled())
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove charlie' })).toBeInTheDocument())

    expect(document.activeElement?.getAttribute('aria-label')).not.toBe('Remove bob')
  })
})
