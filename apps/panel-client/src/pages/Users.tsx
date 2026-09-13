import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Users as UsersIcon,
  UserPlus,
  ShieldAlert,
  Loader2,
  ArrowRight,
  Trash2,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { PageHeader } from '@/components/PageHeader'
import { PageSkeleton } from '@/components/PageSkeleton'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import {
  usersApi,
  permissionsApi,
  ApiError,
  type ManagedUserAccount,
  type RoleInfo,
} from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { panelQueryKeys } from '@/lib/queryClient'

const EMPTY_ROLES: RoleInfo[] = []
const LEGACY_USER_ROLES = ['admin', 'technician', 'moderator'] as const
type LegacyUserRole = (typeof LEGACY_USER_ROLES)[number]
function isLegacyUserRole(name: string): name is LegacyUserRole {
  return (LEGACY_USER_ROLES as readonly string[]).includes(name)
}

function recoveryActionForRole(
  role: RoleInfo | undefined,
): 'manage roles' | 'manage users' | null {
  if (!role) return null
  if (role.capabilities.includes('roles.manage')) return 'manage roles'
  if (role.capabilities.includes('users.manage')) return 'manage users'
  return null
}

export default function Users({ embedded = false }: { embedded?: boolean }) {
  const { toast } = useToast()
  const { user: currentUser } = useAuth()
  const confirm = useConfirm()
  const queryClient = useQueryClient()

  const {
    data: usersData,
    error: usersErrorValue,
    refetch: refetchUsers,
    isPending: usersPending,
  } = useQuery({
    queryKey: panelQueryKeys.users,
    queryFn: usersApi.list,
    retry: false,
    staleTime: 30_000,
  })
  const {
    data: rolesData,
    error: rolesError,
    refetch: refetchRoles,
    isPending: rolesPending,
  } = useQuery({
    queryKey: panelQueryKeys.roles,
    queryFn: permissionsApi.getRoles,
    retry: false,
    staleTime: 30_000,
  })
  const users = usersData?.users ?? null
  const roles = rolesData?.roles ?? EMPTY_ROLES
  const usersError = usersErrorValue ?? rolesError
  const permissionDenied = [usersErrorValue, rolesError].some(
    (error) => error instanceof ApiError && error.status === 403,
  )
  const loadError =
    !permissionDenied && usersError
      ? getUserErrorMessage(usersError, 'Unknown error')
      : null
  const loading = usersPending || rolesPending

  const [createOpen, setCreateOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [roleId, setRoleId] = useState('')
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())

  const rowDeleteButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const pendingFocusTargetRef = useRef<string | 'fallback' | null>(null)
  const addUserButtonRef = useRef<HTMLButtonElement>(null)
  const [failedDeleteFocusId, setFailedDeleteFocusId] = useState<string | null>(
    null,
  )

  useEffect(() => {
    const target = pendingFocusTargetRef.current
    if (target === null) return
    pendingFocusTargetRef.current = null
    if (target === 'fallback') {
      addUserButtonRef.current?.focus()
      return
    }
    rowDeleteButtonRefs.current.get(target)?.focus()
  }, [users])

  useEffect(() => {
    if (failedDeleteFocusId === null) return
    rowDeleteButtonRefs.current.get(failedDeleteFocusId)?.focus()
    setFailedDeleteFocusId(null)
  }, [failedDeleteFocusId])

  const fetchAll = useCallback(() => {
    void Promise.all([refetchUsers(), refetchRoles()])
  }, [refetchRoles, refetchUsers])

  function openCreateDialog() {
    setUsername('')
    setPassword('')
    setConfirmPassword('')
    setRoleId(roles[0]?.id ?? '')
    setFormError(null)
    setCreateOpen(true)
  }

  function getRoleForUser(user: ManagedUserAccount): RoleInfo | undefined {
    return roles.find((r) =>
      user.roleId ? r.id === user.roleId : r.name === user.role,
    )
  }

  async function handleDelete(user: ManagedUserAccount) {
    const ok = await confirm({
      title: 'Remove ' + String(user.username) + '?',
      description:
        "They will lose access to this panel immediately, on their very next request — not eventually. This can't be undone.",
      confirmLabel: 'Remove account',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return

    const currentList = users || []
    const index = currentList.findIndex((u) => u.id === user.id)
    const neighborId = currentList[index + 1]?.id ?? currentList[index - 1]?.id
    pendingFocusTargetRef.current = neighborId ?? 'fallback'

    setDeletingIds((prev) => new Set(prev).add(user.id))
    try {
      await usersApi.remove(user.id)
      queryClient.setQueryData<{ users: ManagedUserAccount[] }>(
        panelQueryKeys.users,
        (previous) =>
          previous
            ? {
                ...previous,
                users: previous.users.filter((u) => u.id !== user.id),
              }
            : previous,
      )
      toast({
        title: 'Account removed',
        description: String(user.username) + ' can no longer sign in.',
        variant: 'success',
      })
    } catch (error) {
      pendingFocusTargetRef.current = null
      setFailedDeleteFocusId(user.id)
      if (
        error instanceof ApiError &&
        error.code === 'ROLE_LOCKOUT_LAST_MANAGER'
      ) {
        const action = recoveryActionForRole(getRoleForUser(user))
        toast({
          title: 'Action failed',
          description:
            'This change would leave no user able to ' + String(action),
          variant: 'destructive',
        })
      } else if (
        error instanceof ApiError &&
        error.code === 'USER_SELF_DELETE_REFUSED'
      ) {
        toast({
          title: 'Action failed',
          description:
            'You cannot delete your own account. Ask another administrator to do it instead.',
          variant: 'destructive',
        })
      } else {
        toast({
          title: 'Action failed',
          description: getUserErrorMessage(error, 'Unknown error'),
          variant: 'destructive',
        })
      }
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev)
        next.delete(user.id)
        return next
      })
    }
  }

  async function handleCreate() {
    if (!username.trim()) {
      setFormError('Enter a username.')
      return
    }
    if (!password) {
      setFormError('Enter a password.')
      return
    }
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.')
      return
    }
    const targetRole = roles.find((r) => r.id === roleId)
    if (!targetRole) {
      setFormError('Choose a role.')
      return
    }

    setFormBusy(true)
    setFormError(null)
    try {
      const legacyRole = isLegacyUserRole(targetRole.name)
        ? targetRole.name
        : undefined
      const { user } = await usersApi.create({
        username: username.trim(),
        password,
        roleId: targetRole.id,
        ...(legacyRole ? { role: legacyRole } : {}),
      })

      setCreateOpen(false)
      await refetchUsers()
      toast({
        title: 'Account created',
        description:
          String(user.username) +
          ' can now sign in as "' +
          String(targetRole.name) +
          '".',
        variant: 'success',
      })
    } catch (error) {
      setFormError(getUserErrorMessage(error, 'Unknown error'))
    } finally {
      setFormBusy(false)
    }
  }

  if (loading) {
    return (
      <PageSkeleton
        variant="list"
        eyebrow={'Accounts'}
        title={'Users'}
        description={
          'The accounts that can sign in to this panel. Add one for anyone who needs their own login, then set what they can do from Roles & Permissions.'
        }
      />
    )
  }

  return (
    <div className={embedded ? 'space-y-4' : 'space-y-6 page-transition'}>
      {embedded ? (
        !permissionDenied && (
          <div className="flex justify-end">
            <Button ref={addUserButtonRef} onClick={openCreateDialog}>
              <UserPlus className="h-4 w-4" />
              {'Add User'}
            </Button>
          </div>
        )
      ) : (
        <PageHeader
          eyebrow={'Accounts'}
          title={'Users'}
          description={
            'The accounts that can sign in to this panel. Add one for anyone who needs their own login, then set what they can do from Roles & Permissions.'
          }
          icon={<UsersIcon className="h-6 w-6" />}
          tone="config"
          actions={
            !permissionDenied ? (
              <Button ref={addUserButtonRef} onClick={openCreateDialog}>
                <UserPlus className="h-4 w-4" />
                {'Add User'}
              </Button>
            ) : undefined
          }
        />
      )}

      {permissionDenied ? (
        <EmptyState
          type="accessDenied"
          icon={<ShieldAlert className="h-14 w-14 text-muted-foreground/40" />}
          title={"You can't manage user accounts"}
          description={
            'Your account\'s role doesn\'t include "Manage user accounts". Ask an administrator to grant it if you need access to this screen.'
          }
        />
      ) : loadError ? (
        <EmptyState
          type="noData"
          title={"Couldn't load accounts"}
          description={loadError}
          action={{ label: 'Try again', onClick: fetchAll }}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/40 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5">{'Account'}</th>
                    <th className="px-4 py-2.5">{'Role'}</th>
                    <th className="px-4 py-2.5">{'Created'}</th>
                    <th className="px-4 py-2.5">{'Last sign-in'}</th>
                    <th className="relative px-4 py-2.5 text-end">
                      <span className="sr-only">{'Actions'}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(users || []).map((user) => {
                    const isSelf = user.id === currentUser?.id
                    const deleting = deletingIds.has(user.id)
                    return (
                      <tr
                        key={user.id}
                        className="border-b border-border/30 last:border-0"
                      >
                        <td className="px-4 py-2.5 font-medium">
                          {user.username}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant="outline">{user.role}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {new Date(user.createdAt).toLocaleString('en')}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {user.lastLogin
                            ? new Date(user.lastLogin).toLocaleString('en')
                            : 'Never'}
                        </td>
                        <td className="px-4 py-2.5 text-end">
                          {!isSelf &&
                            (deleting ? (
                              <Loader2 className="ms-auto h-4 w-4 animate-spin text-muted-foreground" />
                            ) : (
                              <Button
                                ref={(el) => {
                                  if (el)
                                    rowDeleteButtonRefs.current.set(user.id, el)
                                  else
                                    rowDeleteButtonRefs.current.delete(user.id)
                                }}
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                title={'Remove ' + String(user.username)}
                                aria-label={'Remove ' + String(user.username)}
                                onClick={() => handleDelete(user)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            ))}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-border/40 px-4 py-3">
              <Link
                to="/settings"
                search={{ tab: 'roles' }}
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                {'Manage roles & permissions'}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => !open && setCreateOpen(false)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{'Add a user'}</DialogTitle>
            <DialogDescription>
              {
                "Create a login for someone else. They'll use this username and password to sign in."
              }
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-user-username">{'Username'}</Label>
              <Input
                id="new-user-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={'e.g. jsmith'}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-password">{'Password'}</Label>
              <Input
                id="new-user-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {'Use at least 6 characters.'}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-confirm-password">
                {'Confirm password'}
              </Label>
              <Input
                id="new-user-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label>{'Role'}</Label>
                <HelpTip label={'Role'}>
                  {
                    'Sets what this account can do from the moment it signs in — the exact list of allowed actions lives in Roles & Permissions, not here. You can change it any time after creating the account, so a close guess is fine now.'
                  }
                </HelpTip>
              </div>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={'Choose a role…'} />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={formBusy}
            >
              {'Cancel'}
            </Button>
            <Button onClick={handleCreate} disabled={formBusy}>
              {formBusy ? 'Creating…' : 'Create account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
