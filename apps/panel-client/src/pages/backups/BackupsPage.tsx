import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Archive, Download, FileText, Loader2, MoreHorizontal, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react'
import { backupApi, serversApi, type BackupSnapshot, type ServerBackupArchive } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { panelQueryKeys } from '@/lib/queryClient'
import { cn } from '@/lib/utils'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm, type ConfirmOptions } from '@/contexts/ConfirmContext'
import { EmptyState } from '@/components/EmptyState'
import { NumberInput } from '@/components/NumberInput'
import { PageHeader } from '@/components/PageHeader'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardPanel } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress'
import { toastManager } from '@/components/ui/toast'

interface BackupProgress {
  phase: 'preparing' | 'archiving' | 'finalizing' | 'complete' | 'error'
  percent: number
  message: string
  currentFile?: string
}

/** Same wording wherever a full backup is started, because it stops the server. */
export const CREATE_BACKUP_CONFIRM: ConfirmOptions = {
  title: 'Create a full backup?',
  description:
    'If the server is running, the panel saves and stops it, archives the world, config and player accounts, then starts it again. Players are disconnected. The archive contains server credentials.',
  confirmLabel: 'Create backup',
  destructive: false,
}

const SCHEDULES: Record<string, string> = {
  '*/15 * * * *': 'every 15 minutes',
  '*/30 * * * *': 'every 30 minutes',
  '0 * * * *': 'every hour',
  '0 */2 * * *': 'every 2 hours',
  '0 */4 * * *': 'every 4 hours',
  '0 */6 * * *': 'every 6 hours',
  '0 */8 * * *': 'every 8 hours',
  '0 */12 * * *': 'every 12 hours',
  '0 0 * * *': 'daily at midnight',
  '0 6 * * *': 'daily at 6 AM',
  '0 12 * * *': 'daily at noon',
  '0 18 * * *': 'daily at 6 PM',
}
export const describeBackupSchedule = (cron: string | undefined) => (cron ? SCHEDULES[cron] || cron : 'not scheduled')

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

const formatDate = (value: string) => new Date(value).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })

const MAX_UPLOAD_BYTES = 4 * 1024 ** 3
const CHANGED_SERVER = { title: 'The selected server changed', description: 'Refreshing. Try again once the list updates, so the action targets the right server.', type: 'error' as const }

function Stat({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <Card className="gap-1 p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="truncate text-lg font-semibold tabular-nums">{value}</span>
      {detail && <span className="truncate text-sm text-muted-foreground">{detail}</span>}
    </Card>
  )
}

export default function BackupsPage() {
  const socket = useSocket()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ownBackup = useRef(false)

  const { data: activeData, refetch: refetchActive } = useQuery({ queryKey: panelQueryKeys.activeServer, queryFn: serversApi.getResolvedActive, retry: false, staleTime: 0 })
  const { data: status, error: statusError, refetch: refetchStatus, isFetching: statusFetching } = useQuery({ queryKey: panelQueryKeys.backupStatus, queryFn: backupApi.getStatus, retry: false, staleTime: 15_000 })
  const { data: listData, error: listError, refetch: refetchList, isFetching: listFetching, isFetched: listLoaded } = useQuery({ queryKey: panelQueryKeys.backups, queryFn: backupApi.listBackups, retry: false, staleTime: 15_000 })
  const server = activeData?.server ?? null
  const serverId = server?.id ?? null
  const backups: ServerBackupArchive[] = useMemo(() => listData?.backups ?? [], [listData])
  const loadError = statusError ? getUserErrorMessage(statusError, 'Failed to load the backup status.') : listError ? getUserErrorMessage(listError, 'Failed to load backups.') : null

  const [creating, setCreating] = useState(false)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [serverChanged, setServerChanged] = useState(false)
  const [snapshot, setSnapshot] = useState<{ name: string; snapshot: BackupSnapshot } | null>(null)
  const [olderOpen, setOlderOpen] = useState(false)
  const [olderDays, setOlderDays] = useState(7)
  const [maxBackups, setMaxBackups] = useState(10)
  const [savingRetention, setSavingRetention] = useState(false)

  useEffect(() => {
    if (!status) return
    setMaxBackups(status.maxBackups)
    if (status.backupInProgress) setCreating(true)
  }, [status])

  useEffect(() => {
    const names = new Set(backups.map((backup) => backup.name))
    setSelected((prev) => new Set([...prev].filter((name) => names.has(name))))
  }, [backups])

  const refreshAll = useCallback(
    () => Promise.all([refetchActive(), refetchStatus(), refetchList(), queryClient.invalidateQueries({ queryKey: ['backups', 'history'] })]),
    [refetchActive, refetchStatus, refetchList, queryClient],
  )

  const clearProgressLater = (ms: number) => {
    if (progressTimer.current) clearTimeout(progressTimer.current)
    progressTimer.current = setTimeout(() => setProgress(null), ms)
  }

  // A backup started elsewhere (schedule, another tab) has no progress events here, so poll until it ends.
  useEffect(() => {
    if (!creating || ownBackup.current) return
    const interval = setInterval(async () => {
      if (ownBackup.current) return
      try {
        if (!(await backupApi.getStatus()).backupInProgress) {
          setCreating(false)
          setProgress(null)
          await Promise.all([refetchList(), refetchStatus()])
        }
      } catch {
        // A transient failure shouldn't clear the in-progress state.
      }
    }, 10_000)
    return () => clearInterval(interval)
  }, [creating, refetchList, refetchStatus])

  useEffect(() => {
    if (!socket) return
    const onProgress = (data: BackupProgress) => {
      setProgress(data)
      if (data.phase === 'complete') {
        setCreating(false)
        void refetchList()
        void refetchStatus()
        clearProgressLater(2000)
      } else if (data.phase === 'error') {
        setCreating(false)
        clearProgressLater(3000)
      }
    }
    const onServersChanged = () => {
      setServerChanged(true)
      void refreshAll().finally(() => setServerChanged(false))
    }
    socket.on('backup:progress', onProgress)
    socket.on('servers:changed', onServersChanged)
    return () => {
      socket.off('backup:progress', onProgress)
      socket.off('servers:changed', onServersChanged)
      if (progressTimer.current) clearTimeout(progressTimer.current)
    }
  }, [socket, refetchList, refetchStatus, refreshAll])

  const create = async () => {
    if (serverChanged) return toastManager.add(CHANGED_SERVER)
    if (!(await confirm(CREATE_BACKUP_CONFIRM))) return
    ownBackup.current = true
    setCreating(true)
    setProgress({ phase: 'preparing', percent: 0, message: 'Starting the backup…' })
    try {
      const result = await backupApi.createBackup({ expectedServerId: serverId })
      if (!result.success || !result.backup) throw new Error(result.message || 'Failed to create the backup.')
      toastManager.add(
        result.warnings?.length
          ? { title: 'Backup created, with warnings', description: result.warnings.join(' '), type: 'warning' }
          : { title: 'Backup created', description: `${result.backup.name} in ${result.duration?.toFixed(1)}s`, type: 'success' },
      )
      await Promise.all([refetchList(), refetchStatus()])
    } catch (error) {
      toastManager.add({ title: 'Backup failed', description: getUserErrorMessage(error, 'Failed to create the backup.'), type: 'error' })
      setProgress({ phase: 'error', percent: 0, message: 'Backup failed' })
      clearProgressLater(3000)
    } finally {
      setCreating(false)
      ownBackup.current = false
    }
  }

  const upload = async (file: File) => {
    if (serverChanged) return toastManager.add(CHANGED_SERVER)
    const problem = !file.name.toLowerCase().endsWith('.zip')
      ? 'Only .zip backup archives are accepted.'
      : file.size > MAX_UPLOAD_BYTES
        ? `Archives must be 4 GB or smaller. This one is ${(file.size / 1024 ** 3).toFixed(2)} GB.`
        : file.size === 0
          ? 'The selected file is empty.'
          : null
    if (problem) return toastManager.add({ title: "Can't upload that file", description: problem, type: 'error' })
    setUploadPercent(0)
    try {
      const result = await backupApi.uploadBackup(file, setUploadPercent)
      toastManager.add({ title: 'Backup uploaded', description: `Stored as ${result.name}. Restore it from the list.`, type: 'success' })
      await Promise.all([refetchList(), refetchStatus()])
    } catch (error) {
      toastManager.add({ title: 'Upload failed', description: getUserErrorMessage(error, 'Failed to upload the backup.'), type: 'error' })
    } finally {
      setUploadPercent(null)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const restore = async (name: string) => {
    if (serverChanged) return toastManager.add(CHANGED_SERVER)
    const ok = await confirm({
      title: `Restore onto ${server?.name || server?.serverName || 'the selected server'}?`,
      description: `${name} replaces the current world, plus the config and player accounts if the archive has them.\n\nStop the server first. The panel makes a safety backup before restoring; undoing this later means restoring that safety backup yourself.`,
      confirmLabel: 'Restore this backup',
    })
    if (!ok) return
    setRestoring(name)
    try {
      const result = await backupApi.restoreBackup(name, { expectedServerId: serverId })
      toastManager.add({ title: 'Backup restored', description: `Rolled back to ${name} in ${(result.duration || 0).toFixed(1)}s.`, type: 'success' })
      await refetchList()
    } catch (error) {
      toastManager.add({ title: 'Restore failed', description: getUserErrorMessage(error, 'Failed to restore the backup.'), type: 'error' })
    } finally {
      setRestoring(null)
    }
  }

  const remove = async (names: string[]) => {
    if (serverChanged) return toastManager.add(CHANGED_SERVER)
    const ok = await confirm({
      title: names.length === 1 ? 'Delete this backup?' : `Delete ${names.length} backups?`,
      description: names.length === 1 ? `${names[0]} is deleted permanently.` : 'These files are deleted permanently.',
      items: names.length > 1 ? names : undefined,
      confirmLabel: names.length === 1 ? 'Delete backup' : 'Delete backups',
    })
    if (!ok) return
    setDeleting(true)
    let deleted = 0
    for (const name of names) {
      try {
        await backupApi.deleteBackup(name, serverId)
        deleted++
      } catch {
        // Counted below.
      }
    }
    const failed = names.length - deleted
    toastManager.add(
      deleted > 0
        ? { title: `Deleted ${deleted} backup${deleted === 1 ? '' : 's'}`, description: failed ? `${failed} couldn't be deleted.` : undefined, type: failed ? 'warning' : 'success' }
        : { title: "Couldn't delete the backups", type: 'error' },
    )
    setSelected(new Set())
    await refetchList()
    setDeleting(false)
  }

  const deleteOlder = async () => {
    setOlderOpen(false)
    setDeleting(true)
    try {
      const result = await backupApi.deleteOlderThan(olderDays, serverId)
      toastManager.add({ title: 'Old backups deleted', description: result.message || `Deleted ${result.deleted || 0}.`, type: 'success' })
      await refetchList()
    } catch (error) {
      toastManager.add({ title: "Couldn't delete old backups", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  const viewSnapshot = async (name: string) => {
    try {
      const result = await backupApi.getSnapshot(name)
      if (!result.success || !result.snapshot) throw new Error(result.message || 'This backup has no panel snapshot.')
      setSnapshot({ name, snapshot: result.snapshot })
    } catch (error) {
      toastManager.add({ title: 'Snapshot unavailable', description: getUserErrorMessage(error, "Couldn't read the backup snapshot."), type: 'error' })
    }
  }

  const saveRetention = async () => {
    setSavingRetention(true)
    try {
      await backupApi.updateSettings({ maxBackups })
      await refetchStatus()
      toastManager.add({ title: 'Retention saved', type: 'success' })
    } catch (error) {
      toastManager.add({ title: "Couldn't save retention", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setSavingRetention(false)
    }
  }

  const totalSize = useMemo(() => backups.reduce((sum, backup) => sum + backup.size, 0), [backups])
  const restoreElsewhere = restoring === null && Boolean(status?.restoreInProgress)
  const blocked = creating || restoring !== null || restoreElsewhere || serverChanged
  const lastScheduledFailed = Boolean(status?.enabled && status.lastScheduledBackupAttempt && !status.lastScheduledBackupAttempt.success)
  const allSelected = backups.length > 0 && selected.size === backups.length

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Backups"
        description="Full archives of the world, player accounts, server config and panel profile."
        actions={
          <>
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => void refreshAll()} disabled={statusFetching || listFetching}>
              <RefreshCw className={cn((statusFetching || listFetching) && 'animate-spin')} />
            </Button>
            <input ref={fileInput} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={uploadPercent !== null || blocked} title="Upload a backup .zip from another machine">
              {uploadPercent !== null ? <Loader2 className="animate-spin" /> : <Upload />}
              {uploadPercent !== null ? `Uploading ${uploadPercent}%` : 'Upload'}
            </Button>
            <Button onClick={() => void create()} disabled={blocked || !status?.savesExists}>
              {creating ? <Loader2 className="animate-spin" /> : <Archive />}
              {creating ? 'Creating…' : 'Create backup'}
            </Button>
          </>
        }
      />

      {loadError && (
        <Alert variant="error">
          <AlertTriangle />
          <AlertTitle>Backup data unavailable</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void refreshAll()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {lastScheduledFailed && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>The last scheduled backup failed</AlertTitle>
          <AlertDescription>
            {formatDate(status!.lastScheduledBackupAttempt!.executedAt)}: {status?.lastScheduledBackupAttempt?.message}
          </AlertDescription>
        </Alert>
      )}

      {restoring && (
        <Alert variant="warning" role="status">
          <Loader2 className="animate-spin" />
          <AlertTitle>Restoring {restoring}…</AlertTitle>
          <AlertDescription>This can take a few minutes for a large world. Keep the panel open.</AlertDescription>
        </Alert>
      )}

      {(creating || progress) && (
        <Progress value={progress?.percent || 0}>
          <div className="flex justify-between gap-4 text-sm">
            <span className="font-medium">{progress?.message || 'Creating the backup…'}</span>
            <span className="tabular-nums text-muted-foreground">{progress?.percent || 0}%</span>
          </div>
          <ProgressTrack>
            <ProgressIndicator className={cn(progress?.phase === 'error' && 'bg-destructive')} />
          </ProgressTrack>
          {progress?.currentFile && <span className="truncate text-sm text-muted-foreground">{progress.currentFile}</span>}
        </Progress>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Backups" value={backups.length} />
        <Stat label="Total size" value={formatBytes(totalSize)} />
        <Stat label="Last backup" value={status?.lastBackup ? formatDate(status.lastBackup.created) : 'Never'} />
        <Stat
          label="Automatic backups"
          value={status?.enabled ? 'On' : 'Off'}
          detail={
            <Link to="/schedule" className="underline-offset-4 hover:underline">
              {status?.enabled ? `Runs ${describeBackupSchedule(status.schedule)}. Change in Schedule` : 'Turn on in Schedule'}
            </Link>
          }
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b">
          <label className="flex items-center gap-3 text-sm font-medium">
            <Checkbox checked={allSelected} onCheckedChange={() => setSelected(allSelected ? new Set() : new Set(backups.map((b) => b.name)))} disabled={backups.length === 0} />
            {selected.size > 0 ? `${selected.size} of ${backups.length} selected` : 'Backup files'}
          </label>
          <div className="flex flex-wrap gap-2">
            {selected.size > 0 && (
              <Button size="sm" variant="destructive-outline" onClick={() => void remove([...selected])} disabled={deleting || serverChanged}>
                <Trash2 />
                Delete {selected.size}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setOlderOpen(true)} disabled={deleting || backups.length === 0}>
              Delete older…
            </Button>
          </div>
        </CardHeader>
        <CardPanel className="p-0">
          {status && !status.savesExists && listLoaded && backups.length === 0 ? (
            <EmptyState
              compact
              type="empty"
              title="No saves folder found"
              description="The panel couldn't find a Saves/Multiplayer folder for this server. Start the server once to create it, or check its data folder in Server settings."
              action={{ label: 'Open Server settings', to: '/server-settings' }}
            />
          ) : backups.length === 0 ? (
            <EmptyState compact type="noData" title="No backups yet" description="Make one before changing saves, mods or server settings." action={{ label: 'Create backup', onClick: () => void create(), variant: 'default' }} />
          ) : (
            <ul className="max-h-[32rem] divide-y overflow-y-auto">
              {backups.map((backup, index) => {
                const isSelected = selected.has(backup.name)
                return (
                  <li key={backup.name} className={cn('grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-6 py-3', isSelected && 'bg-accent')}>
                    <Checkbox
                      checked={isSelected}
                      aria-label={`Select ${backup.name}`}
                      disabled={restoring === backup.name}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(backup.name)) next.delete(backup.name)
                          else next.add(backup.name)
                          return next
                        })
                      }
                    />
                    <div className="grid min-w-0 gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-mono text-sm">{backup.name}</span>
                        {index === 0 && <Badge variant="secondary">Latest</Badge>}
                      </span>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {formatBytes(backup.size)} · {formatDate(backup.created)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => void restore(backup.name)} disabled={blocked}>
                        {restoring === backup.name ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                        Restore
                      </Button>
                      <Menu>
                        <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`More actions for ${backup.name}`} />}>
                          <MoreHorizontal />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={() => void viewSnapshot(backup.name)}>
                            <FileText />
                            View server snapshot
                          </MenuItem>
                          <MenuItem onClick={() => backupApi.downloadBackup(backup.name)}>
                            <Download />
                            Download
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem variant="destructive" onClick={() => void remove([backup.name])} disabled={deleting || serverChanged}>
                            <Trash2 />
                            Delete
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardPanel>
      </Card>

      <SettingsCard title="Retention">
        <SettingsRow label="Keep at most" description="When a new backup goes over this, the oldest is deleted.">
          <div className="flex items-center gap-2">
            <NumberInput className="w-20" min={1} max={100} value={maxBackups} onChange={setMaxBackups} />
            <span className="text-sm text-muted-foreground">backups</span>
            <Button size="sm" variant="outline" onClick={() => void saveRetention()} disabled={savingRetention || maxBackups === status?.maxBackups || !Number.isFinite(maxBackups)}>
              Save
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          label="In-game snapshots"
          description="Project Zomboid also makes its own rotating snapshots while the server runs, without stopping it. New servers make one an hour and keep five."
        >
          <Button size="sm" variant="ghost" render={<Link to="/config" />}>
            Set in Configuration
          </Button>
        </SettingsRow>
        {status?.savesPath && (
          <SettingsRow label="Saves folder">
            <code className="font-mono text-sm break-all">{status.savesPath}</code>
          </SettingsRow>
        )}
      </SettingsCard>

      <Dialog open={olderOpen} onOpenChange={setOlderOpen}>
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete old backups?</DialogTitle>
            <DialogDescription>Every backup older than this is deleted permanently.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="flex items-center gap-2 text-sm">
              Older than
              <NumberInput className="w-20" min={1} max={365} value={olderDays} onChange={setOlderDays} />
              days
            </label>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={() => void deleteOlder()} disabled={!Number.isFinite(olderDays)}>
              Delete old backups
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={snapshot !== null} onOpenChange={(open) => !open && setSnapshot(null)}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Server snapshot</DialogTitle>
            <DialogDescription className="font-mono">{snapshot?.name}</DialogDescription>
          </DialogHeader>
          {snapshot && (
            <DialogPanel className="grid gap-4 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Server</dt>
                <dd>{snapshot.snapshot.server.name}</dd>
                <dt className="text-muted-foreground">Provider</dt>
                <dd>{snapshot.snapshot.server.provider}</dd>
                <dt className="text-muted-foreground">Captured</dt>
                <dd>{formatDate(snapshot.snapshot.createdAt)}</dd>
              </dl>
              {[
                ['Server .ini', snapshot.snapshot.serverIni],
                ['Sandbox', snapshot.snapshot.sandboxVars],
              ].map(([label, values]) => (
                <div key={label as string} className="grid gap-1">
                  <span className="font-medium">{label as string}</span>
                  <pre className="max-h-40 overflow-auto rounded-lg border bg-muted p-2 font-mono text-xs">
                    {Object.entries(values as Record<string, string>)
                      .map(([key, value]) => `${key}=${value}`)
                      .join('\n') || 'Nothing captured'}
                  </pre>
                </div>
              ))}
            </DialogPanel>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
