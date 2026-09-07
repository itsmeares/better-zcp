import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, ShieldAlert, Plus, Pencil, Trash2, Loader2, Lock, ChevronDown } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { PageSkeleton } from '@/components/PageSkeleton'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
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
import { useConfirm } from '@/contexts/ConfirmContext'
import {
  permissionsApi,
  usersApi,
  ApiError,
  type CapabilityInfo,
  type RoleInfo,
  type ManagedUserAccount,
} from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { panelQueryKeys } from '@/lib/queryClient'

const RECOVERY_CAPABILITY_KEYS = new Set(['roles.manage', 'users.manage'])
const EMPTY_ROLES: RoleInfo[] = []

function recoveryActionKey(
  existingCapabilities: string[],
  nextCapabilities: string[],
): 'lockout.actionManageRoles' | 'lockout.actionManageUsers' | null {
  const removes = (capability: string) =>
    existingCapabilities.includes(capability) && !nextCapabilities.includes(capability)
  if (removes('roles.manage')) return 'lockout.actionManageRoles'
  if (removes('users.manage')) return 'lockout.actionManageUsers'
  return null
}

export default function RolesPermissions({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation(['roles', 'errors'])
  const { toast } = useToast()
  const confirm = useConfirm()
  const queryClient = useQueryClient()

  const {
    data: capabilitiesData,
    error: capabilitiesError,
    refetch: refetchCapabilities,
    isPending: capabilitiesPending,
  } = useQuery({
    queryKey: panelQueryKeys.capabilities,
    queryFn: permissionsApi.getCapabilities,
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
  const {
    data: usersData,
    error: usersError,
    refetch: refetchUsers,
  } = useQuery({
    queryKey: panelQueryKeys.users,
    queryFn: usersApi.list,
    retry: false,
    staleTime: 30_000,
  })
  const groups = capabilitiesData?.groups ?? []
  const roles = rolesData?.roles ?? EMPTY_ROLES
  const users = usersData?.users ?? null
  const matrixError = capabilitiesError ?? rolesError
  const permissionDenied = [capabilitiesError, rolesError].some(
    (error) => error instanceof ApiError && error.status === 403,
  )
  const loadError = !permissionDenied && matrixError
    ? getUserErrorMessage(matrixError, t('toasts.unknownError'))
    : null
  const loading = capabilitiesPending || rolesPending
  const usersDenied = usersError instanceof ApiError && usersError.status === 403
  const usersLoadError = !usersDenied && usersError
    ? getUserErrorMessage(usersError, t('toasts.unknownError'))
    : null

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  const [savingCells, setSavingCells] = useState<Set<string>>(new Set())
  const [savingUserRows, setSavingUserRows] = useState<Set<string>>(new Set())

  const pendingCapabilitiesRef = useRef<Map<string, string[]>>(new Map())

  const roleHeaderButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const pendingFocusTargetRef = useRef<string | 'fallback' | null>(null)
  const addRoleButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const target = pendingFocusTargetRef.current
    if (target === null) return
    pendingFocusTargetRef.current = null
    if (target === 'fallback') {
      addRoleButtonRef.current?.focus()
      return
    }
    roleHeaderButtonRefs.current.get(target)?.focus()
  }, [roles])

  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<RoleInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RoleInfo | null>(null)

  const [formName, setFormName] = useState('')
  const [formCapabilities, setFormCapabilities] = useState<Set<string>>(new Set())
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [reassignTo, setReassignTo] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const fetchUsers = useCallback(async () => {
    await refetchUsers()
  }, [refetchUsers])

  const fetchMatrix = useCallback(async () => {
    await Promise.all([
      refetchCapabilities(),
      refetchRoles(),
      refetchUsers(),
    ])
  }, [refetchCapabilities, refetchRoles, refetchUsers])

  function capabilityLabel(cap: CapabilityInfo): string {
    return t(`capabilities.${cap.key}.label`, { defaultValue: cap.label })
  }
  function capabilityDescription(cap: CapabilityInfo): string {
    return t(`capabilities.${cap.key}.description`, { defaultValue: cap.description })
  }
  function groupLabel(group: string): string {
    return t(`capabilityGroups.${group}`, { defaultValue: group })
  }

  async function applyRoleCapabilities(
    role: RoleInfo,
    nextCapabilities: string[],
    confirmSelfCapabilityLoss: boolean,
    existingCapabilities: string[],
  ): Promise<boolean> {
    try {
      const { role: updated } = await permissionsApi.updateRole(role.id, {
        capabilities: nextCapabilities,
        confirmSelfCapabilityLoss,
      })
      if (pendingCapabilitiesRef.current.get(role.id) === nextCapabilities) {
        queryClient.setQueryData<{ roles: RoleInfo[] }>(panelQueryKeys.roles, (previous) =>
          previous
            ? { ...previous, roles: previous.roles.map((r) => (r.id === role.id ? { ...r, ...updated } : r)) }
            : previous,
        )
      }
      return true
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROLE_SELF_CAPABILITY_LOSS_CONFIRM') {
        const actionKey = recoveryActionKey(existingCapabilities, nextCapabilities)
        const action = actionKey ? t(actionKey) : ''
        const ok = await confirm({
          title: t('confirmSelfCapabilityLoss.title'),
          description: t('confirmSelfCapabilityLoss.description', { action }),
          confirmLabel: t('confirmSelfCapabilityLoss.confirm'),
          cancelLabel: t('confirmSelfCapabilityLoss.cancel'),
        })
        if (ok) return applyRoleCapabilities(role, nextCapabilities, true, existingCapabilities)
        return false
      }
      if (error instanceof ApiError && error.code === 'ROLE_LOCKOUT_LAST_MANAGER') {
        const actionKey = recoveryActionKey(existingCapabilities, nextCapabilities)
        const action = actionKey ? t(actionKey) : ''
        toast({
          title: t('toasts.actionFailedTitle'),
          description: t('errors:ROLE_LOCKOUT_LAST_MANAGER', { action }),
          variant: 'destructive',
        })
        return false
      }
      toast({
        title: t('toasts.actionFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: 'destructive',
      })
      return false
    }
  }

  async function handleToggleCapability(role: RoleInfo, cap: CapabilityInfo, checked: boolean) {
    const cellKey = `${role.id}:${cap.key}`
    if (savingCells.has(cellKey)) return
    setSavingCells((prev) => new Set(prev).add(cellKey))

    const baseCapabilities = pendingCapabilitiesRef.current.get(role.id) ?? role.capabilities
    const nextCapabilities = checked
      ? [...baseCapabilities, cap.key]
      : baseCapabilities.filter((c) => c !== cap.key)
    pendingCapabilitiesRef.current.set(role.id, nextCapabilities)

    const ok = await applyRoleCapabilities(role, nextCapabilities, false, baseCapabilities)

    if (pendingCapabilitiesRef.current.get(role.id) === nextCapabilities) {
      pendingCapabilitiesRef.current.delete(role.id)
    }

    if (ok) {
      toast({
        description: t(checked ? 'toasts.capabilityGranted' : 'toasts.capabilityRevoked', {
          capability: capabilityLabel(cap),
          role: role.name,
        }),
        variant: 'success',
      })
    }
    setSavingCells((prev) => {
      const next = new Set(prev)
      next.delete(cellKey)
      return next
    })
  }

  function openCreateDialog() {
    setFormName('')
    setFormCapabilities(new Set())
    setFormError(null)
    setCreateOpen(true)
  }

  async function handleCreateSubmit() {
    const name = formName.trim()
    if (!name) {
      setFormError(t('roleFormDialog.nameRequired'))
      return
    }
    setFormBusy(true)
    setFormError(null)
    try {
      const { role } = await permissionsApi.createRole({
        name,
        capabilities: Array.from(formCapabilities),
      })
      queryClient.setQueryData<{ roles: RoleInfo[] }>(panelQueryKeys.roles, (previous) =>
        previous ? { ...previous, roles: [...previous.roles, { ...role, memberCount: 0 }] } : { roles: [{ ...role, memberCount: 0 }] },
      )
      setCreateOpen(false)
      toast({
        title: t('toasts.roleCreatedTitle'),
        description: t('toasts.roleCreatedDescription', { name: role.name }),
        variant: 'success',
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROLE_NAME_TAKEN') {
        setFormError(t('errors:ROLE_NAME_TAKEN', { name }))
      } else {
        setFormError(getUserErrorMessage(error, t('toasts.unknownError')))
      }
    } finally {
      setFormBusy(false)
    }
  }

  function openRenameDialog(role: RoleInfo) {
    setFormName(role.name)
    setFormError(null)
    setRenameTarget(role)
  }

  async function handleRenameSubmit() {
    if (!renameTarget) return
    const name = formName.trim()
    if (!name) {
      setFormError(t('roleFormDialog.nameRequired'))
      return
    }
    setFormBusy(true)
    setFormError(null)
    try {
      const { role: updated } = await permissionsApi.updateRole(renameTarget.id, { name })
      queryClient.setQueryData<{ roles: RoleInfo[] }>(panelQueryKeys.roles, (previous) =>
        previous
          ? {
              ...previous,
              roles: previous.roles.map((r) =>
                r.id === renameTarget.id ? { ...r, name: updated.name, updatedAt: updated.updatedAt } : r,
              ),
            }
          : previous,
      )
      setRenameTarget(null)
      toast({
        title: t('toasts.roleRenamedTitle'),
        description: t('toasts.roleRenamedDescription', { name: updated.name }),
        variant: 'success',
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROLE_NAME_TAKEN') {
        setFormError(t('errors:ROLE_NAME_TAKEN', { name }))
      } else {
        setFormError(getUserErrorMessage(error, t('toasts.unknownError')))
      }
    } finally {
      setFormBusy(false)
    }
  }

  function openDeleteDialog(role: RoleInfo) {
    setReassignTo('')
    setDeleteError(null)
    setDeleteTarget(role)
  }

  async function handleDeleteSubmit() {
    if (!deleteTarget) return
    if (deleteTarget.memberCount > 0 && !reassignTo) {
      setDeleteError(t('errors:ROLE_HAS_MEMBERS', { count: deleteTarget.memberCount }))
      return
    }
    const index = roles.findIndex((r) => r.id === deleteTarget.id)
    const neighborId = roles[index + 1]?.id ?? roles[index - 1]?.id
    pendingFocusTargetRef.current = neighborId ?? 'fallback'

    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const result = await permissionsApi.deleteRole(deleteTarget.id, reassignTo || undefined)
      const targetRole = roles.find((r) => r.id === reassignTo)
      queryClient.setQueryData<{ roles: RoleInfo[] }>(panelQueryKeys.roles, (previous) =>
        previous
          ? {
              ...previous,
              roles: previous.roles
                .filter((r) => r.id !== deleteTarget.id)
                .map((r) =>
                  reassignTo && r.id === reassignTo ? { ...r, memberCount: r.memberCount + result.reassigned } : r,
                ),
            }
          : previous,
      )
      toast({
        title: t('toasts.roleDeletedTitle'),
        description: targetRole
          ? t('toasts.roleDeletedReassignedDescription', { name: deleteTarget.name, target: targetRole.name })
          : t('toasts.roleDeletedDescription', { name: deleteTarget.name }),
        variant: 'success',
      })
      setDeleteTarget(null)
      if (result.reassigned > 0) fetchUsers()
    } catch (error) {
      pendingFocusTargetRef.current = null
      if (error instanceof ApiError && error.code === 'ROLE_LOCKOUT_LAST_MANAGER') {
        const nextCapabilities = reassignTo ? roles.find((r) => r.id === reassignTo)?.capabilities || [] : []
        const actionKey = recoveryActionKey(deleteTarget.capabilities, nextCapabilities)
        const action = actionKey ? t(actionKey) : ''
        setDeleteError(t('errors:ROLE_LOCKOUT_LAST_MANAGER', { action }))
      } else if (error instanceof ApiError && error.code === 'ROLE_HAS_MEMBERS') {
        setDeleteError(t('errors:ROLE_HAS_MEMBERS', { count: deleteTarget.memberCount }))
      } else {
        setDeleteError(getUserErrorMessage(error, t('toasts.unknownError')))
      }
    } finally {
      setDeleteBusy(false)
    }
  }

  function getRoleForUser(user: ManagedUserAccount): RoleInfo | undefined {
    return roles.find((r) => (user.roleId ? r.id === user.roleId : r.name === user.role))
  }

  async function handleAssignRole(user: ManagedUserAccount, roleId: string) {
    const currentRole = getRoleForUser(user)
    if (currentRole?.id === roleId) return
    setSavingUserRows((prev) => new Set(prev).add(user.id))
    try {
      const { user: updated } = await usersApi.assignRole(user.id, roleId)
      queryClient.setQueryData<{ users: ManagedUserAccount[] }>(panelQueryKeys.users, (previous) =>
        previous
          ? {
              ...previous,
              users: previous.users.map((u) =>
                u.id === user.id ? { ...u, role: updated.role, roleId: updated.roleId } : u,
              ),
            }
          : previous,
      )
      const newRole = roles.find((r) => r.id === roleId)
      toast({
        title: t('toasts.userRoleAssignedTitle'),
        description: t('toasts.userRoleAssignedDescription', {
          username: user.username,
          role: newRole?.name || updated.role,
        }),
        variant: 'success',
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROLE_LOCKOUT_LAST_MANAGER') {
        const targetRole = roles.find((r) => r.id === roleId)
        const actionKey = recoveryActionKey(currentRole?.capabilities || [], targetRole?.capabilities || [])
        const action = actionKey ? t(actionKey) : ''
        toast({
          title: t('toasts.actionFailedTitle'),
          description: t('errors:ROLE_LOCKOUT_LAST_MANAGER', { action }),
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
      setSavingUserRows((prev) => {
        const next = new Set(prev)
        next.delete(user.id)
        return next
      })
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
            <Button ref={addRoleButtonRef} onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              {t('toolbar.newRole')}
            </Button>
          </div>
        )
      ) : (
        <PageHeader
          eyebrow={t('pageHeader.eyebrow')}
          title={t('pageHeader.title')}
          description={t('pageHeader.description')}
          icon={<ShieldCheck className="h-6 w-6" />}
          tone="config"
          actions={
            !permissionDenied ? (
              <Button ref={addRoleButtonRef} onClick={openCreateDialog}>
                <Plus className="h-4 w-4" />
                {t('toolbar.newRole')}
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
          action={{ label: t('loadError.retry'), onClick: fetchMatrix }}
        />
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              {roles.length > 1 && (
                <p className="border-b border-border/60 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground sm:hidden">
                  {t('matrix.scrollHint')}
                </p>
              )}
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border/60">
                      <th className="sticky left-0 top-0 z-30 border-b border-border/60 bg-muted px-3 py-2 text-start align-top text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('matrix.capabilityColumnHeader')}
                      </th>
                      {roles.map((role) => (
                        <th key={role.id} className="sticky top-0 z-20 min-w-[170px] border-b border-border/60 bg-muted px-3 py-2 text-start align-top">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-foreground">{role.name}</span>
                            {role.isSeeded && (
                              <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase tracking-wide">
                                {t('matrix.seededBadge')}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2">
                            <span className="text-xs font-normal text-muted-foreground">
                              {t('matrix.memberCount', { count: role.memberCount })}
                            </span>
                            <div className="flex items-center gap-1">
                              <Button
                                ref={(el) => {
                                  if (el) roleHeaderButtonRefs.current.set(role.id, el)
                                  else roleHeaderButtonRefs.current.delete(role.id)
                                }}
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                title={t('matrix.renameTooltip')}
                                aria-label={t('matrix.renameTooltip')}
                                onClick={() => openRenameDialog(role)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              {role.isSeeded ? (
                                <span title={t('matrix.deleteSeededTooltip')}>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground/40"
                                    disabled
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </span>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-destructive hover:text-destructive"
                                  title={t('matrix.deleteTooltip')}
                                  aria-label={t('matrix.deleteTooltip')}
                                  onClick={() => openDeleteDialog(role)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => {
                      const collapsed = collapsedGroups.has(group.group)
                      return (
                      <Fragment key={group.group}>
                        <tr className="border-t border-border/50 bg-muted/30">
                          <td colSpan={roles.length + 1} className="sticky left-0 bg-muted/30 p-0">
                            <button
                              type="button"
                              onClick={() => toggleGroup(group.group)}
                              aria-expanded={!collapsed}
                              className="flex w-full items-center gap-1.5 px-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-foreground/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                            >
                              <ChevronDown
                                className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`}
                                aria-hidden="true"
                              />
                              {groupLabel(group.group)}
                              {collapsed && (
                                <span className="font-normal normal-case tracking-normal text-muted-foreground/80">
                                  ({t('matrix.capabilityCount', { count: group.capabilities.length })})
                                </span>
                              )}
                            </button>
                          </td>
                        </tr>
                        {!collapsed && group.capabilities.map((cap) => (
                          <tr key={cap.key} className="border-b border-border/30 last:border-0 hover:bg-muted/10">
                            <td className="sticky left-0 z-10 bg-card px-3 py-2 align-middle">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium text-foreground">{capabilityLabel(cap)}</span>
                                <HelpTip label={capabilityLabel(cap)}>{capabilityDescription(cap)}</HelpTip>
                                {RECOVERY_CAPABILITY_KEYS.has(cap.key) && (
                                  <span title={t('matrix.recoveryCapabilityHint')}>
                                    <Lock
                                      className="h-3 w-3 shrink-0 text-warning"
                                      aria-label={t('matrix.recoveryCapabilityHint')}
                                    />
                                  </span>
                                )}
                              </div>
                            </td>
                            {roles.map((role) => {
                              const cellKey = `${role.id}:${cap.key}`
                              const checked = role.capabilities.includes(cap.key)
                              const busy = savingCells.has(cellKey)
                              return (
                                <td key={role.id} className="px-3 py-2 text-center align-middle">
                                  {busy ? (
                                    <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                                  ) : (
                                    <Checkbox
                                      checked={checked}
                                      onCheckedChange={(value) => handleToggleCapability(role, cap, value === true)}
                                      aria-label={`${role.name}: ${capabilityLabel(cap)}`}
                                    />
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('userAssignment.title')}</CardTitle>
              <CardDescription>{t('userAssignment.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {usersDenied ? (
                <EmptyState
                  compact
                  type="accessDenied"
                  icon={<ShieldAlert className="h-10 w-10 text-muted-foreground/40" />}
                  title={t('userAssignment.permissionDenied.title')}
                  description={t('userAssignment.permissionDenied.description')}
                />
              ) : usersLoadError ? (
                <EmptyState
                  compact
                  type="noData"
                  title={t('loadError.title')}
                  description={usersLoadError}
                  action={{ label: t('loadError.retry'), onClick: fetchUsers }}
                />
              ) : !users ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : users.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('userAssignment.noUsers')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/60 text-start text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2">{t('userAssignment.usernameColumn')}</th>
                        <th className="px-3 py-2">{t('userAssignment.roleColumn')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => {
                        const currentRole = getRoleForUser(user)
                        const busy = savingUserRows.has(user.id)
                        return (
                          <tr key={user.id} className="border-b border-border/30 last:border-0">
                            <td className="px-3 py-2 font-medium">{user.username}</td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <Select
                                  value={currentRole?.id ?? ''}
                                  onValueChange={(value) => handleAssignRole(user, value)}
                                  disabled={busy}
                                >
                                  <SelectTrigger className="h-9 w-56">
                                    <SelectValue placeholder={t('userAssignment.rolePlaceholder')} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {roles.map((role) => (
                                      <SelectItem key={role.id} value={role.id}>
                                        {role.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                {busy && (
                                  <span className="text-xs text-muted-foreground">{t('userAssignment.savingRow')}</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={createOpen} onOpenChange={(open) => !open && setCreateOpen(false)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('roleFormDialog.createTitle')}</DialogTitle>
            <DialogDescription>{t('roleFormDialog.createDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-role-name">{t('roleFormDialog.nameLabel')}</Label>
              <Input
                id="new-role-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t('roleFormDialog.namePlaceholder')}
              />
            </div>
            <div className="space-y-3">
              {groups.map((group) => (
                <div key={group.group}>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {groupLabel(group.group)}
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {group.capabilities.map((cap) => (
                      <label key={cap.key} className="flex items-start gap-2 text-sm">
                        <Checkbox
                          className="mt-0.5"
                          checked={formCapabilities.has(cap.key)}
                          onCheckedChange={(value) =>
                            setFormCapabilities((prev) => {
                              const next = new Set(prev)
                              if (value === true) next.add(cap.key)
                              else next.delete(cap.key)
                              return next
                            })
                          }
                        />
                        <span>{capabilityLabel(cap)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={formBusy}>
              {t('roleFormDialog.cancel')}
            </Button>
            <Button onClick={handleCreateSubmit} disabled={formBusy}>
              {formBusy ? t('roleFormDialog.creating') : t('roleFormDialog.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('roleFormDialog.renameTitle', { name: renameTarget?.name })}</DialogTitle>
            <DialogDescription>{t('roleFormDialog.renameDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rename-role-name">{t('roleFormDialog.nameLabel')}</Label>
            <Input id="rename-role-name" value={formName} onChange={(e) => setFormName(e.target.value)} />
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={formBusy}>
              {t('roleFormDialog.cancel')}
            </Button>
            <Button onClick={handleRenameSubmit} disabled={formBusy}>
              {formBusy ? t('roleFormDialog.saving') : t('roleFormDialog.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteRoleDialog.title', { name: deleteTarget?.name })}</DialogTitle>
            <DialogDescription>
              {deleteTarget && deleteTarget.memberCount > 0
                ? t('deleteRoleDialog.descriptionWithMembers', { count: deleteTarget.memberCount })
                : t('deleteRoleDialog.descriptionNoMembers')}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && deleteTarget.memberCount > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label>{t('deleteRoleDialog.reassignLabel')}</Label>
                <HelpTip label={t('deleteRoleDialog.reassignLabel')}>
                  {t('deleteRoleDialog.reassignTip')}
                </HelpTip>
              </div>
              <Select value={reassignTo} onValueChange={setReassignTo}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={t('deleteRoleDialog.reassignPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {roles
                    .filter((r) => r.id !== deleteTarget.id)
                    .map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              {t('deleteRoleDialog.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDeleteSubmit} disabled={deleteBusy}>
              {deleteBusy ? t('deleteRoleDialog.confirming') : t('deleteRoleDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
