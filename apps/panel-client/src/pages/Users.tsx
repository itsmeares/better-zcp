import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { Users as UsersIcon, UserPlus, ShieldAlert, Loader2, ArrowRight, Trash2 } from 'lucide-react'
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

const LEGACY_USER_ROLES = ['admin', 'technician', 'moderator'] as const
type LegacyUserRole = (typeof LEGACY_USER_ROLES)[number]
const EMPTY_ROLES: RoleInfo[] = []
function isLegacyUserRole(name: string): name is LegacyUserRole {
  return (LEGACY_USER_ROLES as readonly string[]).includes(name)
}

function recoveryActionKeyForRole(role: RoleInfo | undefined): 'lockout.actionManageRoles' | 'lockout.actionManageUsers' | null {
  if (!role) return null
  if (role.capabilities.includes('roles.manage')) return 'lockout.actionManageRoles'
  if (role.capabilities.includes('users.manage')) return 'lockout.actionManageUsers'
  return null
}

export default function Users({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation(['users', 'errors'])
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
  const loadError = !permissionDenied && usersError
    ? getUserErrorMessage(usersError, t('toasts.unknownError'))
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
  const [failedDeleteFocusId, setFailedDeleteFocusId] = useState<string | null>(null)

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
    return roles.find((r) => (user.roleId ? r.id === user.roleId : r.name === user.role))
  }

  async function handleDelete(user: ManagedUserAccount) {
    const ok = await confirm({
      title: t('deleteDialog.title', { username: user.username }),
      description: t('deleteDialog.description'),
      confirmLabel: t('deleteDialog.confirm'),
      cancelLabel: t('deleteDialog.cancel'),
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
      queryClient.setQueryData<{ users: ManagedUserAccount[] }>(panelQueryKeys.users, (previous) =>
        previous ? { ...previous, users: previous.users.filter((u) => u.id !== user.id) } : previous,
      )
      toast({
        title: t('toasts.userDeletedTitle'),
        description: t('toasts.userDeletedDescription', { username: user.username }),
        variant: 'success',
      })
    } catch (error) {
      pendingFocusTargetRef.current = null
      setFailedDeleteFocusId(user.id)
      if (error instanceof ApiError && error.code === 'ROLE_LOCKOUT_LAST_MANAGER') {
        const actionKey = recoveryActionKeyForRole(getRoleForUser(user))
        const action = actionKey ? t(actionKey) : ''
        toast({
          title: t('toasts.actionFailedTitle'),
          description: t('errors:ROLE_LOCKOUT_LAST_MANAGER', { action }),
          variant: 'destructive',
        })
      } else if (error instanceof ApiError && error.code === 'USER_SELF_DELETE_REFUSED') {
        toast({
          title: t('toasts.actionFailedTitle'),
          description: t('errors:USER_SELF_DELETE_REFUSED'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('toasts.actionFailedTitle'),
          description: getUserErrorMessage(error, t('toasts.unknownError')),
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
      setFormError(t('createDialog.usernameRequired'))
      return
    }
    if (!password) {
      setFormError(t('createDialog.passwordRequired'))
      return
    }
    if (password !== confirmPassword) {
      setFormError(t('createDialog.passwordsDontMatch'))
      return
    }
    const targetRole = roles.find((r) => r.id === roleId)
    if (!targetRole) {
      setFormError(t('createDialog.roleRequired'))
      return
    }

    setFormBusy(true)
    setFormError(null)
    try {
      const creationRole: LegacyUserRole = isLegacyUserRole(targetRole.name)
        ? targetRole.name
        : 'moderator'
      const { user } = await usersApi.create({
        username: username.trim(),
        password,
        role: creationRole,
      })

      if (creationRole !== targetRole.name) {
        try {
          await usersApi.assignRole(user.id, targetRole.id)
        } catch (error) {
          setCreateOpen(false)
          queryClient.setQueryData<{ users: ManagedUserAccount[] }>(panelQueryKeys.users, (previous) =>
            previous ? { ...previous, users: [...previous.users, user] } : { users: [user] },
          )
          toast({
            title: t('toasts.userCreatedTitle'),
            description: t('toasts.userCreatedRoleAssignFailedDescription', {
              username: user.username,
              role: targetRole.name,
              reason: getUserErrorMessage(error, t('toasts.unknownError')),
            }),
            variant: 'destructive',
          })
          return
        }
      }

      setCreateOpen(false)
      await refetchUsers()
      toast({
        title: t('toasts.userCreatedTitle'),
        description: t('toasts.userCreatedDescription', {
          username: user.username,
          role: targetRole.name,
        }),
        variant: 'success',
      })
    } catch (error) {
      setFormError(getUserErrorMessage(error, t('toasts.unknownError')))
    } finally {
      setFormBusy(false)
    }
  }

  if (loading) {
    return (
      <PageSkeleton
        variant="list"
        eyebrow={t('pageHeader.eyebrow')}
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
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
              {t('toolbar.addUser')}
            </Button>
          </div>
        )
      ) : (
        <PageHeader
          eyebrow={t('pageHeader.eyebrow')}
          title={t('pageHeader.title')}
          description={t('pageHeader.description')}
          icon={<UsersIcon className="h-6 w-6" />}
          tone="config"
          actions={
            !permissionDenied ? (
              <Button ref={addUserButtonRef} onClick={openCreateDialog}>
                <UserPlus className="h-4 w-4" />
                {t('toolbar.addUser')}
              </Button>
            ) : undefined
          }
        />
      )}

      {permissionDenied ? (
        <EmptyState
          type="accessDenied"
          icon={<ShieldAlert className="h-14 w-14 text-muted-foreground/40" />}
          title={t('permissionDenied.title')}
          description={t('permissionDenied.description')}
        />
      ) : loadError ? (
        <EmptyState
          type="noData"
          title={t('loadError.title')}
          description={loadError}
          action={{ label: t('loadError.retry'), onClick: fetchAll }}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/40 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5">{t('table.account')}</th>
                    <th className="px-4 py-2.5">{t('table.role')}</th>
                    <th className="px-4 py-2.5">{t('table.created')}</th>
                    <th className="px-4 py-2.5">{t('table.lastSignIn')}</th>
                    <th className="relative px-4 py-2.5 text-end">
                      <span className="sr-only">{t('table.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(users || []).map((user) => {
                    const isSelf = user.id === currentUser?.id
                    const deleting = deletingIds.has(user.id)
                    return (
                      <tr key={user.id} className="border-b border-border/30 last:border-0">
                        <td className="px-4 py-2.5 font-medium">{user.username}</td>
                        <td className="px-4 py-2.5">
                          <Badge variant="outline">{user.role}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {new Date(user.createdAt).toLocaleString(i18n.language)}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {user.lastLogin ? new Date(user.lastLogin).toLocaleString(i18n.language) : t('table.never')}
                        </td>
                        <td className="px-4 py-2.5 text-end">
                          {!isSelf && (
                            deleting ? (
                              <Loader2 className="ms-auto h-4 w-4 animate-spin text-muted-foreground" />
                            ) : (
                              <Button
                                ref={(el) => {
                                  if (el) rowDeleteButtonRefs.current.set(user.id, el)
                                  else rowDeleteButtonRefs.current.delete(user.id)
                                }}
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                title={t('table.removeTooltip', { username: user.username })}
                                aria-label={t('table.removeTooltip', { username: user.username })}
                                onClick={() => handleDelete(user)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )
                          )}
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
                {t('manageRolesLink')}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={createOpen} onOpenChange={(open) => !open && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('createDialog.title')}</DialogTitle>
            <DialogDescription>{t('createDialog.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-user-username">{t('createDialog.usernameLabel')}</Label>
              <Input
                id="new-user-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('createDialog.usernamePlaceholder')}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-password">{t('createDialog.passwordLabel')}</Label>
              <Input
                id="new-user-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">{t('createDialog.passwordHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-confirm-password">{t('createDialog.confirmPasswordLabel')}</Label>
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
                <Label>{t('createDialog.roleLabel')}</Label>
                <HelpTip label={t('createDialog.roleLabel')}>{t('createDialog.roleTip')}</HelpTip>
              </div>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={t('createDialog.rolePlaceholder')} />
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
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={formBusy}>
              {t('createDialog.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={formBusy}>
              {formBusy ? t('createDialog.creating') : t('createDialog.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
