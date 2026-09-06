import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Users from '../Users'
import { usersApi, permissionsApi, type ManagedUserAccount } from '@/lib/api'

// Focus-restore-after-delete pattern (2026-08-26, Pam found the shape, this
// pins the fix). On a successful delete, handleDelete removes the row a
// moment after the dialog closes, unmounting whatever button focus was on --
// React doesn't move focus when an element unmounts, so the browser silently
// drops it to document.body with no visible indication of where a keyboard
// user now is. Users.tsx computes the right neighbor/fallback target while
// the row still exists and moves focus there once `users` actually updates.
//
// On a FAILED delete the row survives, so that effect never fires (nothing
// about `users` changed) -- Users.tsx instead focuses the surviving button
// directly in the catch branch. That direct call exists because Radix's own
// onCloseAutoFocus does NOT reliably restore focus to the trigger here --
// A real Chromium smoke test, not jsdom, showed activeElement landing on
// document.body after this
// exact flow, a genuine keyboard-accessibility defect, not a test artifact.

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
  // A real mouse click focuses the clicked element before firing the click
  // event -- fireEvent.click alone does NOT simulate that (a well-known
  // jsdom/testing-library gap; @testing-library/user-event isn't a
  // dependency of this project). Radix's AlertDialog restores focus to
  // whatever was focused when it opened, so without this, the trigger is
  // never actually focused and there is nothing real for Radix to restore
  // TO on close -- not a reflection of real-browser behaviour.
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
      <MemoryRouter>
        <ConfirmProvider>
          <Users />
        </ConfirmProvider>
      </MemoryRouter>,
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
      <MemoryRouter>
        <ConfirmProvider>
          <Users />
        </ConfirmProvider>
      </MemoryRouter>,
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
      <MemoryRouter>
        <ConfirmProvider>
          <Users />
        </ConfirmProvider>
      </MemoryRouter>,
    )

    await confirmDelete('alice')

    await waitFor(() => expect(removeUser).toHaveBeenCalledWith('u1'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove alice' })).not.toBeInTheDocument())

    const addUserButton = screen.getByRole('button', { name: /Add User/i })
    await waitFor(() => expect(document.activeElement).toBe(addUserButton))
  })

  it('does not move focus at all when the delete fails -- the row survives, and a later unrelated users-state change does not steal focus either', async () => {
    // 2026-08-31 bug hunt, second pass: this test previously stopped at
    // "the row survives" because a document.activeElement assertion placed
    // immediately after the failed delete can't catch the regression it's
    // meant to guard -- pendingFocusTargetRef is only *consumed* by an
    // effect keyed on `users` (Users.tsx), and a failed delete alone never
    // changes `users`. Proved by break-verify at the time: removing the
    // catch branch's ref reset left this file's tests all green. Finishing
    // it now needs a SECOND, unrelated `users` state change afterward (a
    // successful create, same as the real app would produce) to actually
    // exercise the effect.
    const userA = makeUser('u1', 'alice')
    const userB = makeUser('u2', 'bob')
    const userC = makeUser('u3', 'charlie')
    listUsers.mockResolvedValueOnce({ users: [userA, userB] })
    removeUser.mockRejectedValue(new Error('boom'))
    // openCreateDialog() pre-selects roleId from roles[0] (Users.tsx), so a
    // single seeded role lets handleCreate succeed without needing to
    // drive the role <Select> -- confirmed elsewhere in this suite that
    // Radix's Select cannot be driven via fireEvent in jsdom (e.g.
    // Events.generateWeatherFront.test.tsx).
    getRoles.mockReset().mockResolvedValue({ roles: [{ id: 'role-mod', name: 'moderator', capabilities: [] }] })
    createUser.mockResolvedValue({ success: true, user: userC })
    listUsers.mockResolvedValueOnce({ users: [userA, userB, userC] })

    render(
      <MemoryRouter>
        <TooltipProvider>
          <ConfirmProvider>
            <Users />
          </ConfirmProvider>
        </TooltipProvider>
      </MemoryRouter>,
    )

    await confirmDelete('alice')

    await waitFor(() => expect(removeUser).toHaveBeenCalledWith('u1'))
    // The row is still there -- a failed delete must not have claimed a
    // focus target that later fires against a row that never actually left.
    const aliceButtonStillThere = await screen.findByRole('button', { name: 'Remove alice' })
    expect(aliceButtonStillThere).toBeInTheDocument()

    // A real-browser check against a server, not jsdom, showed that after this
    // exact flow
    // -- trigger correctly pre-focused, dialog confirmed, delete rejected
    // -- document.activeElement lands on document.body, not the trigger,
    // against the UNFIXED component. Confirmed reproducible, not a jsdom
    // artifact: a genuine Radix onCloseAutoFocus / keyboard-accessibility
    // gap. Users.tsx's failedDeleteFocusId effect (see its comment) now
    // focuses the surviving button explicitly instead of trusting Radix's
    // restore -- pin that fix here. An earlier attempt called .focus()
    // synchronously in the catch branch instead of via that effect, and it
    // did NOT hold even in jsdom -- Radix's focus trap was still active at
    // that exact point and won the race back to document.body; deferring
    // to an effect (post-commit, same idiom as the success-path effect
    // above it) is what actually sticks.
    await waitFor(() => expect(document.activeElement).toBe(aliceButtonStillThere))

    // Now the actual regression: a LATER, unrelated users-state change
    // (a successful create, going through the real Add User dialog) must
    // not yank focus onto some other row just because a delete failed
    // earlier in the session.
    fireEvent.click(screen.getByRole('button', { name: /Add User/i }))
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'charlie' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'NewUserPassw0rd!7' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'NewUserPassw0rd!7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => expect(createUser).toHaveBeenCalled())
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove charlie' })).toBeInTheDocument())

    // If handleDelete's catch branch didn't reset pendingFocusTargetRef, it
    // would still hold 'u2' (bob, alice's neighbor) from the failed
    // delete's setup -- and this later `users` change (from fetchAll after
    // the create) would fire the focus-restore effect and steal focus onto
    // bob's remove button, even though nothing about creating charlie
    // should move focus anywhere. Asserted by aria-label, not a captured
    // element reference -- fetchAll flips `loading` back to true during the
    // refetch, which unmounts the whole table behind a PageSkeleton, so any
    // "Remove bob" button reference grabbed before this point is stale and
    // a reference-identity check against it would pass even when a BRAND
    // NEW "Remove bob" button legitimately has focus (caught this the hard
    // way via break-verify: an earlier `not.toBe(bobButton)` version of
    // this assertion stayed green even with the regression reintroduced).
    expect(document.activeElement?.getAttribute('aria-label')).not.toBe('Remove bob')
  })
})
