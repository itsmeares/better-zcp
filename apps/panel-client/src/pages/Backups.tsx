import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  Download,
  Trash2,
  RotateCcw,
  Loader2,
  Clock,
  HardDrive,
  FolderOpen,
  RefreshCw,
  Settings,
  AlertTriangle,
  Check,
  Upload,
  FileText,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { NumberInput } from '@/components/NumberInput'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/contexts/SocketContext'
import {
  backupApi,
  serversApi,
  BackupSnapshot,
  type ServerBackupArchive,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { PageHeader } from '@/components/PageHeader'
import { DisabledReason } from '@/components/DisabledReason'
import { useAuth } from '@/contexts/AuthContext'
import { EmptyState } from '@/components/EmptyState'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { panelQueryKeys } from '@/lib/queryClient'

interface BackupProgress {
  phase: 'preparing' | 'archiving' | 'finalizing' | 'complete' | 'error'
  percent: number
  message: string
  filesProcessed?: number
  totalFiles?: number
  currentFile?: string
}

const EMPTY_BACKUPS: ServerBackupArchive[] = []

export default function Backups() {
  const { toast } = useToast()
  const socket = useSocket()
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const canManageBackups = can('backups.manage')
  const canRestoreBackups = can('backups.restore')
  const canDownloadBackups = can('backups.download')

  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ownBackupInFlightRef = useRef(false)

  const {
    data: activeServerData,
    refetch: refetchActiveServer,
    isFetching: activeServerFetching,
  } = useQuery({
    queryKey: panelQueryKeys.activeServer,
    queryFn: serversApi.getResolvedActive,
    retry: false,
    staleTime: 0,
  })
  const {
    data: backupStatus,
    error: backupStatusError,
    refetch: refetchBackupStatus,
    isFetching: backupStatusFetching,
  } = useQuery({
    queryKey: panelQueryKeys.backupStatus,
    queryFn: backupApi.getStatus,
    retry: false,
    staleTime: 15_000,
  })
  const {
    data: backupsData,
    error: backupsError,
    refetch: refetchBackups,
    isFetching: backupsFetching,
    isFetched: backupsLoaded,
  } = useQuery({
    queryKey: panelQueryKeys.backups,
    queryFn: backupApi.listBackups,
    retry: false,
    staleTime: 15_000,
  })
  const activeServer = activeServerData?.server ?? null
  const activeServerId = activeServer?.id ?? null
  const activeServerRemote = Boolean(activeServer?.isRemote)
  const backups = backupsData?.backups ?? EMPTY_BACKUPS
  const historyQuery = useQuery({
    queryKey:
      activeServerId == null
        ? ['backups', 'history', 'none']
        : panelQueryKeys.backupHistory(activeServerId),
    queryFn: () => backupApi.getHistory(activeServerId as string | number),
    enabled: activeServerId != null,
    retry: false,
    staleTime: 15_000,
  })
  const history = historyQuery.data?.records ?? []
  const loading =
    activeServerFetching || backupStatusFetching || backupsFetching
  const loadError = backupStatusError
    ? getUserErrorMessage(backupStatusError, 'Failed to load backup status.')
    : backupsError
      ? getUserErrorMessage(backupsError, 'Failed to load backups.')
      : null
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
  const [deletingBackups, setDeletingBackups] = useState(false)
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(
    null,
  )
  const [uploadingBackup, setUploadingBackup] = useState(false)
  const [uploadPercent, setUploadPercent] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [serverChangedSinceLoad, setServerChangedSinceLoad] = useState(false)
  const [restoreTargetServerName, setRestoreTargetServerName] = useState<
    string | null
  >(null)

  const [selectedBackups, setSelectedBackups] = useState<Set<string>>(new Set())

  const [showSettings, setShowSettings] = useState(false)
  const [backupSchedule, setBackupSchedule] = useState('0 */6 * * *')
  const [backupMaxCount, setBackupMaxCount] = useState(10)
  const [savingSettings, setSavingSettings] = useState(false)

  const [restoreDialog, setRestoreDialog] = useState<{
    open: boolean
    backupName: string | null
  }>({
    open: false,
    backupName: null,
  })
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean
    names: string[]
  }>({
    open: false,
    names: [],
  })
  const [deleteOlderDialog, setDeleteOlderDialog] = useState(false)
  const [deleteOlderDays, setDeleteOlderDays] = useState(7)
  const [deletingOlder, setDeletingOlder] = useState(false)
  const [snapshotDialog, setSnapshotDialog] = useState<{
    name: string
    snapshot: BackupSnapshot
  } | null>(null)

  useEffect(() => {
    if (!backupStatus) return
    setBackupSchedule(backupStatus.schedule)
    setBackupMaxCount(backupStatus.maxBackups)
    if (backupStatus.backupInProgress) {
      setCreatingBackup(true)
    }
  }, [backupStatus])

  useEffect(() => {
    setSelectedBackups((previous) => {
      const backupNames = new Set(backups.map((backup) => backup.name))
      return new Set([...previous].filter((name) => backupNames.has(name)))
    })
  }, [backups])

  const fetchBackupStatus = useCallback(async () => {
    await refetchBackupStatus()
  }, [refetchBackupStatus])

  const fetchBackups = useCallback(async () => {
    await refetchBackups()
  }, [refetchBackups])

  useEffect(() => {
    if (!creatingBackup || ownBackupInFlightRef.current) return
    const interval = setInterval(async () => {
      if (ownBackupInFlightRef.current) return
      try {
        const status = await backupApi.getStatus()
        if (!status.backupInProgress) {
          setCreatingBackup(false)
          setBackupProgress(null)
          await fetchBackups()
          await fetchBackupStatus()
        }
      } catch {
        // A transient status failure should not clear the in-progress state.
      }
    }, 10_000)
    return () => clearInterval(interval)
  }, [creatingBackup, fetchBackups, fetchBackupStatus])

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refetchActiveServer(),
      fetchBackupStatus(),
      fetchBackups(),
      queryClient.invalidateQueries({ queryKey: ['backups', 'history'] }),
    ])
  }, [refetchActiveServer, fetchBackupStatus, fetchBackups, queryClient])

  useEffect(() => {
    if (!socket) return

    const handleBackupProgress = (data: BackupProgress) => {
      setBackupProgress(data)

      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
        progressTimeoutRef.current = null
      }

      if (data.phase === 'complete') {
        setCreatingBackup(false)
        fetchBackups()
        fetchBackupStatus()
        progressTimeoutRef.current = setTimeout(
          () => setBackupProgress(null),
          2000,
        )
      } else if (data.phase === 'error') {
        setCreatingBackup(false)
        progressTimeoutRef.current = setTimeout(
          () => setBackupProgress(null),
          3000,
        )
      }
    }

    socket.on('backup:progress', handleBackupProgress)

    return () => {
      socket.off('backup:progress', handleBackupProgress)
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
      }
    }
  }, [socket, fetchBackups, fetchBackupStatus])

  useEffect(() => {
    if (!socket) return
    const handleActiveServerChanged = () => {
      setServerChangedSinceLoad(true)
      setRestoreDialog({ open: false, backupName: null })
      setDeleteDialog({ open: false, names: [] })
      refreshAll().finally(() => setServerChangedSinceLoad(false))
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, refreshAll])

  const handleCreateBackup = async () => {
    if (!canManageBackups) return
    if (serverChangedSinceLoad) {
      toast({
        title: 'Active server changed',
        description:
          'The active server just changed. Refreshing -- try again once the list updates, so this action targets the right server.',
        variant: 'destructive',
      })
      return
    }
    if (progressTimeoutRef.current) {
      clearTimeout(progressTimeoutRef.current)
      progressTimeoutRef.current = null
    }
    ownBackupInFlightRef.current = true
    setCreatingBackup(true)
    setBackupProgress({
      phase: 'preparing',
      percent: 0,
      message: 'Starting backup...',
    })
    try {
      const result = await backupApi.createBackup()
      if (result.success && result.backup) {
        toast({
          title: 'Safehouse Snapshot Created',
          description:
            'Stored ' +
            String(result.backup.name) +
            ' in ' +
            String(result.duration?.toFixed(1)) +
            's',
          variant: 'success' as const,
        })
        await fetchBackups()
        await fetchBackupStatus()
      } else {
        throw new Error(result.message || 'Failed to create backup')
      }
    } catch (error) {
      toast({
        title: 'Backup Failed',
        description: getUserErrorMessage(error, 'Failed to create backup'),
        variant: 'destructive',
      })
      setBackupProgress({
        phase: 'error',
        percent: 0,
        message: 'Backup failed',
      })
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
      }
      progressTimeoutRef.current = setTimeout(
        () => setBackupProgress(null),
        3000,
      )
    } finally {
      setCreatingBackup(false)
      ownBackupInFlightRef.current = false
    }
  }

  const handleUploadFile = async (file: File) => {
    if (!canManageBackups) return
    if (serverChangedSinceLoad) {
      toast({
        title: 'Active server changed',
        description:
          'The active server just changed. Refreshing -- try again once the list updates, so this action targets the right server.',
        variant: 'destructive',
      })
      return
    }
    if (!file) return
    if (activeServerRemote) {
      toast({
        title: 'Not available for remote servers',
        description:
          "Backup uploads write to the local filesystem and aren't supported for remote servers.",
        variant: 'destructive',
      })
      return
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast({
        title: 'Invalid file',
        description: 'Only .zip backup archives are accepted.',
        variant: 'destructive',
      })
      return
    }
    const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({
        title: 'File too large',
        description:
          'Backup archives must be 4 GB or smaller. This file is ' +
          String((file.size / (1024 * 1024 * 1024)).toFixed(2)) +
          ' GB.',
        variant: 'destructive',
      })
      return
    }
    if (file.size === 0) {
      toast({
        title: 'Empty file',
        description: 'The selected .zip is empty.',
        variant: 'destructive',
      })
      return
    }
    setUploadingBackup(true)
    setUploadPercent(0)
    try {
      const result = await backupApi.uploadBackup(file, setUploadPercent)
      toast({
        title: 'Backup Uploaded',
        description:
          'Stored as ' + String(result.name) + '. Use Restore to apply it.',
        variant: 'success' as const,
      })
      await fetchBackups()
      await fetchBackupStatus()
    } catch (error) {
      toast({
        title: 'Upload Failed',
        description: getUserErrorMessage(error, 'Failed to upload backup'),
        variant: 'destructive',
      })
    } finally {
      setUploadingBackup(false)
      setUploadPercent(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const openRestoreDialog = (name: string) => {
    setRestoreDialog({ open: true, backupName: name })
    setRestoreTargetServerName(
      activeServer?.name || activeServer?.serverName || null,
    )
  }

  const handleRestoreBackup = async (name: string) => {
    if (!canRestoreBackups) return
    if (serverChangedSinceLoad) {
      toast({
        title: 'Active server changed',
        description:
          'The active server just changed. Refreshing -- try again once the list updates, so this action targets the right server.',
        variant: 'destructive',
      })
      return
    }
    setRestoreDialog({ open: false, backupName: null })
    setRestoringBackup(name)
    try {
      const result = await backupApi.restoreBackup(name, {
        createPreRestoreBackup: true,
      })
      toast({
        title: 'Recovery Point Restored',
        description:
          'Rolled back to ' +
          String(name) +
          ' in ' +
          String((result.duration || 0).toFixed(1)) +
          's',
        variant: 'success' as const,
      })
      await fetchBackups()
    } catch (error) {
      toast({
        title: 'Restore Failed',
        description: getUserErrorMessage(error, 'Failed to restore backup'),
        variant: 'destructive',
      })
    } finally {
      setRestoringBackup(null)
    }
  }

  const handleViewSnapshot = async (name: string) => {
    if (!canManageBackups) return
    try {
      const result = await backupApi.getSnapshot(name)
      if (!result.success || !result.snapshot)
        throw new Error(result.message || 'No panel snapshot in this backup')
      setSnapshotDialog({ name, snapshot: result.snapshot })
    } catch (error) {
      toast({
        title: 'Snapshot unavailable',
        description: getUserErrorMessage(
          error,
          'Could not read backup snapshot',
        ),
        variant: 'destructive',
      })
    }
  }

  const handleDeleteBackups = async (names: string[]) => {
    if (!canManageBackups) return
    if (serverChangedSinceLoad) {
      toast({
        title: 'Active server changed',
        description:
          'The active server just changed. Refreshing -- try again once the list updates, so this action targets the right server.',
        variant: 'destructive',
      })
      return
    }
    setDeleteDialog({ open: false, names: [] })
    setDeletingBackups(true)
    try {
      let successCount = 0
      let failCount = 0
      for (const name of names) {
        try {
          await backupApi.deleteBackup(name)
          successCount++
        } catch {
          failCount++
        }
      }

      if (successCount > 0) {
        toast({
          title: 'Old Snapshots Cleared',
          description:
            (Number(successCount) === 1
              ? 'Removed ' + String(successCount) + ' backup'
              : 'Removed ' + String(successCount) + ' backups') +
            (failCount > 0 ? ' (' + String(failCount) + ' failed)' : ''),
          variant: 'success' as const,
        })
      }
      if (failCount > 0 && successCount === 0) {
        toast({
          title: 'Delete Failed',
          description:
            Number(failCount) === 1
              ? 'Failed to delete ' + String(failCount) + ' backup'
              : 'Failed to delete ' + String(failCount) + ' backups',
          variant: 'destructive',
        })
      }

      setSelectedBackups(new Set())
      await fetchBackups()
    } catch (error) {
      toast({
        title: 'Delete Failed',
        description: getUserErrorMessage(error, 'Failed to delete backups'),
        variant: 'destructive',
      })
    } finally {
      setDeletingBackups(false)
    }
  }

  const handleDeleteOlderThan = async () => {
    if (!canManageBackups) return
    setDeleteOlderDialog(false)
    setDeletingOlder(true)
    try {
      const result = await backupApi.deleteOlderThan(deleteOlderDays)
      toast({
        title: 'Old Backups Removed',
        description:
          result.message ||
          (Number(result.deleted || 0) === 1
            ? 'Removed ' + String(result.deleted || 0) + ' aging backup'
            : 'Removed ' + String(result.deleted || 0) + ' aging backups'),
        variant: 'success' as const,
      })
      await fetchBackups()
    } catch (error) {
      toast({
        title: 'Delete Failed',
        description: getUserErrorMessage(error, 'Failed to delete old backups'),
        variant: 'destructive',
      })
    } finally {
      setDeletingOlder(false)
    }
  }

  const handleSaveSettings = async () => {
    if (!canManageBackups) return
    setSavingSettings(true)
    try {
      await backupApi.updateSettings({
        enabled: backupStatus?.enabled || false,
        schedule: backupSchedule,
        maxBackups: backupMaxCount,
      })
      await fetchBackupStatus()
      toast({
        title: 'Backup Plan Updated',
        description: 'The panel saved your current backup schedule and limits.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Backup Plan Update Failed',
        description: getUserErrorMessage(error, 'Failed to save settings'),
        variant: 'destructive',
      })
    } finally {
      setSavingSettings(false)
    }
  }

  const toggleBackupEnabled = async (enabled: boolean) => {
    if (!canManageBackups) return
    try {
      await backupApi.updateSettings({ enabled })
      await fetchBackupStatus()
      toast({
        title: enabled
          ? 'Automatic Snapshots Armed'
          : 'Automatic Snapshots Stood Down',
        description: enabled
          ? 'Recurring backup jobs are now active.'
          : 'Recurring backup jobs are currently paused.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Automatic Backup Update Failed',
        description: getUserErrorMessage(
          error,
          'Failed to update backup settings',
        ),
        variant: 'destructive',
      })
    }
  }

  const toggleBackupSelection = (name: string) => {
    setSelectedBackups((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(name)) {
        newSet.delete(name)
      } else {
        newSet.add(name)
      }
      return newSet
    })
  }

  const toggleSelectAll = () => {
    if (selectedBackups.size === backups.length) {
      setSelectedBackups(new Set())
    } else {
      setSelectedBackups(new Set(backups.map((b) => b.name)))
    }
  }

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr)
    return (
      date.toLocaleDateString('en') +
      ' ' +
      date.toLocaleTimeString('en', {
        hour: '2-digit',
        minute: '2-digit',
      })
    )
  }

  const lastScheduledAttemptFailed = Boolean(
    backupStatus?.enabled &&
    backupStatus?.lastScheduledBackupAttempt &&
    !backupStatus.lastScheduledBackupAttempt.success,
  )

  const describeSchedule = (cron: string | undefined): string => {
    if (!cron) return 'No schedule'
    const map: Record<string, string> = {
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
    return map[cron] || cron
  }

  const totalSize = useMemo(() => {
    return backups.reduce((sum, b) => sum + b.size, 0)
  }, [backups])

  const isAnySelected = selectedBackups.size > 0
  const allSelected =
    backups.length > 0 && selectedBackups.size === backups.length

  const restoreInProgressElsewhere =
    restoringBackup === null && Boolean(backupStatus?.restoreInProgress)

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={'World Backups'}
        description={'Create, restore, and manage your server world backups'}
        icon={<Archive className="w-5 h-5 text-primary" />}
        actions={
          <>
            <DisabledReason
              reason={
                !canManageBackups
                  ? "Managing backups requires the backups.manage permission, which this role doesn't have."
                  : activeServerRemote
                    ? 'Backups are not available for remote servers'
                    : null
              }
            >
              <Button
                onClick={handleCreateBackup}
                disabled={
                  creatingBackup ||
                  restoringBackup !== null ||
                  restoreInProgressElsewhere ||
                  !backupStatus?.savesExists ||
                  activeServerRemote ||
                  !canManageBackups ||
                  serverChangedSinceLoad
                }
                className="gap-2"
              >
                {creatingBackup ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Archive className="w-4 h-4" />
                )}
                {creatingBackup ? 'Creating...' : 'Create Backup'}
              </Button>
            </DisabledReason>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleUploadFile(file)
              }}
            />
            <DisabledReason
              reason={
                !canManageBackups
                  ? "Managing backups requires the backups.manage permission, which this role doesn't have."
                  : activeServerRemote
                    ? 'Backups are not available for remote servers'
                    : null
              }
            >
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={
                  uploadingBackup ||
                  restoringBackup !== null ||
                  restoreInProgressElsewhere ||
                  activeServerRemote ||
                  !canManageBackups ||
                  serverChangedSinceLoad
                }
                className="gap-2"
                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Upload an existing world_backup_*.zip from another machine"); the actual disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                title={
                  'Upload an existing world_backup_*.zip from another machine'
                }
              >
                {uploadingBackup ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                {uploadingBackup
                  ? 'Uploading ' + String(uploadPercent) + '%'
                  : 'Upload .zip'}
              </Button>
            </DisabledReason>
            <Button
              variant="outline"
              onClick={() => setShowSettings(!showSettings)}
              className="gap-2"
            >
              <Settings className="w-4 h-4" />
              {'Settings'}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={refreshAll}
              disabled={loading}
              aria-label={'Refresh backup status'}
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; disables only transiently while a refresh is already in flight (the spinning icon is the self-evident "why"), not a permission gate needing DisabledReason. Triaged 2026-08-27.
              title={'Refresh backup status'}
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            </Button>
          </>
        }
      />

      {loadError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{'Backup data unavailable'}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{loadError}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshAll}
              className="self-start sm:self-auto"
            >
              <RefreshCw className="me-2 h-4 w-4" />
              {'Retry'}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {activeServerRemote && (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle>{'Backups disabled for remote servers'}</AlertTitle>
          <AlertDescription>
            {
              "The active server is configured as remote, so the panel can't reach its filesystem. Create, upload, and restore are unavailable until you switch to a local server."
            }
          </AlertDescription>
        </Alert>
      )}

      {activeServerId != null && history.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-border/50 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{'History'}</span>
          <span>
            {Number(history.length) === 1
              ? String(history.length) + ' recorded backup'
              : String(history.length) + ' recorded backups'}
          </span>
          <span>{'Latest: ' + String(formatDate(history[0].createdAt))}</span>
          <span className="font-mono">{history[0].fileName}</span>
        </div>
      )}

      {backups.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger-in">
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div
                className="grid place-items-center w-10 h-10 rounded-md border border-primary/30 bg-primary/[0.06] text-primary shrink-0"
                aria-hidden="true"
              >
                <Archive className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {'Total Backups'}
                </p>
                <p className="text-xl font-semibold leading-tight mt-0.5 text-foreground">
                  {backups.length}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div
                className="grid place-items-center w-10 h-10 rounded-md border border-border/55 bg-muted/30 text-muted-foreground shrink-0"
                aria-hidden="true"
              >
                <HardDrive className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {'Total Size'}
                </p>
                <p className="text-xl font-semibold leading-tight mt-0.5 text-foreground tabular-nums">
                  {formatBytes(totalSize)}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div
                className="grid place-items-center w-10 h-10 rounded-md border border-primary/30 bg-primary/[0.06] text-primary shrink-0"
                aria-hidden="true"
              >
                <Clock className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {'Last Backup'}
                </p>
                <p className="text-sm font-semibold leading-tight mt-0.5 text-foreground truncate">
                  {backupStatus?.lastBackup
                    ? formatDate(backupStatus.lastBackup.created)
                    : 'Never'}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div
                className={cn(
                  'grid place-items-center w-10 h-10 rounded-md border shrink-0',
                  lastScheduledAttemptFailed
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    : backupStatus?.enabled
                      ? 'border-primary/30 bg-primary/[0.06] text-primary'
                      : 'border-border/55 bg-muted/30 text-muted-foreground',
                )}
                aria-hidden="true"
              >
                {lastScheduledAttemptFailed ? (
                  <AlertTriangle className="w-4 h-4" />
                ) : (
                  <Clock className="w-4 h-4" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {'Auto-Backup'}
                </p>
                <p
                  className={cn(
                    'text-sm font-semibold leading-tight mt-0.5 truncate',
                    backupStatus?.enabled
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  {backupStatus?.enabled ? 'On' : 'Off'}
                </p>
                {lastScheduledAttemptFailed ? (
                  <p
                    className="text-[11px] text-amber-600 dark:text-amber-400 truncate"
                    title={
                      backupStatus?.lastScheduledBackupAttempt?.message || ''
                    }
                  >
                    {'Last scheduled attempt failed (' +
                      String(
                        formatDate(
                          backupStatus!.lastScheduledBackupAttempt!.executedAt,
                        ),
                      ) +
                      '): ' +
                      String(
                        backupStatus?.lastScheduledBackupAttempt?.message || '',
                      )}
                  </p>
                ) : (
                  <p
                    className="text-[11px] text-muted-foreground/80 truncate"
                    title={backupStatus?.schedule || ''}
                  >
                    {backupStatus?.enabled
                      ? 'Runs ' +
                        String(describeSchedule(backupStatus?.schedule)) +
                        ' · keep ' +
                        String(backupStatus?.maxBackups ?? '?')
                      : 'No scheduled backups'}
                  </p>
                )}
              </div>
              <DisabledReason
                reason={
                  !canManageBackups
                    ? "Managing backups requires the backups.manage permission, which this role doesn't have."
                    : null
                }
              >
                <Switch
                  checked={backupStatus?.enabled || false}
                  onCheckedChange={toggleBackupEnabled}
                  disabled={!canManageBackups}
                  aria-label={'Toggle scheduled backups'}
                />
              </DisabledReason>
            </CardContent>
          </Card>
        </div>
      )}

      {showSettings && (
        <Card className="border-primary/15">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings className="w-5 h-5" />
              {'Backup Settings'}
            </CardTitle>
            <CardDescription>
              {'Configure scheduled backup settings.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="backup-schedule">{'Backup Frequency'}</Label>
                <Select
                  value={backupSchedule}
                  onValueChange={setBackupSchedule}
                >
                  <SelectTrigger id="backup-schedule" className="w-full">
                    <SelectValue placeholder={'Select frequency'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="*/15 * * * *">
                      {'every 15 minutes'}
                    </SelectItem>
                    <SelectItem value="*/30 * * * *">
                      {'every 30 minutes'}
                    </SelectItem>
                    <SelectItem value="0 * * * *">{'every hour'}</SelectItem>
                    <SelectItem value="0 */2 * * *">
                      {'every 2 hours'}
                    </SelectItem>
                    <SelectItem value="0 */4 * * *">
                      {'every 4 hours'}
                    </SelectItem>
                    <SelectItem value="0 */6 * * *">
                      {'every 6 hours'}
                    </SelectItem>
                    <SelectItem value="0 */8 * * *">
                      {'every 8 hours'}
                    </SelectItem>
                    <SelectItem value="0 */12 * * *">
                      {'every 12 hours'}
                    </SelectItem>
                    <SelectItem value="0 0 * * *">
                      {'daily at midnight'}
                    </SelectItem>
                    <SelectItem value="0 6 * * *">{'daily at 6 AM'}</SelectItem>
                    <SelectItem value="0 12 * * *">
                      {'daily at noon'}
                    </SelectItem>
                    <SelectItem value="0 18 * * *">
                      {'daily at 6 PM'}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {'How often to automatically create backups'}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="backup-max">{'Maximum Backups to Keep'}</Label>
                <NumberInput
                  id="backup-max"
                  min={1}
                  max={100}
                  value={backupMaxCount}
                  onChange={setBackupMaxCount}
                  onWheel={(e) => e.currentTarget.blur()}
                  className="max-w-24"
                />
                <p className="text-xs text-muted-foreground">
                  {'Oldest backups will be auto-deleted when limit is reached'}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-xs text-muted-foreground">
                {backupStatus?.savesPath && (
                  <span className="flex flex-wrap items-center gap-1 break-all">
                    <FolderOpen className="w-3 h-3" />
                    {'Saves: ' + String(backupStatus.savesPath)}
                  </span>
                )}
              </div>
              <DisabledReason
                reason={
                  !canManageBackups
                    ? "Managing backups requires the backups.manage permission, which this role doesn't have."
                    : null
                }
              >
                <Button
                  onClick={handleSaveSettings}
                  disabled={savingSettings || !canManageBackups}
                  size="sm"
                  className="h-10 gap-2 self-start sm:self-auto"
                >
                  {savingSettings && (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  )}
                  {'Save Settings'}
                </Button>
              </DisabledReason>
            </div>
          </CardContent>
        </Card>
      )}

      {restoringBackup && (
        <Card className="border-warning/15 bg-warning/5">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-warning shrink-0" />
              <div className="min-w-0">
                <p className="font-medium truncate">
                  {'Restoring ' + String(restoringBackup) + '…'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {
                    "This can take a few minutes depending on world size. Don't close the panel or navigate away."
                  }
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {(creatingBackup || backupProgress) && (
        <Card className="border-primary/15 bg-primary/5">
          <CardContent className="pt-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {backupProgress?.phase === 'complete' ? (
                    <Check className="w-5 h-5 text-primary" />
                  ) : backupProgress?.phase === 'error' ? (
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                  ) : (
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  )}
                  <span className="font-medium">
                    {backupProgress?.message || 'Creating backup...'}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {backupProgress?.percent || 0}%
                </span>
              </div>
              <Progress value={backupProgress?.percent || 0} className="h-2" />
              {backupProgress?.currentFile && (
                <p className="text-xs text-muted-foreground truncate">
                  {backupProgress.currentFile}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className="text-lg">{'Backup Files'}</CardTitle>
              {!backupStatus?.savesExists && (
                <span className="flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle className="w-3 h-3" />
                  {'Saves folder not found'}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isAnySelected && (
                <DisabledReason
                  reason={
                    !canManageBackups
                      ? "Managing backups requires the backups.manage permission, which this role doesn't have."
                      : null
                  }
                >
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() =>
                      setDeleteDialog({
                        open: true,
                        names: Array.from(selectedBackups),
                      })
                    }
                    disabled={
                      deletingBackups ||
                      !canManageBackups ||
                      serverChangedSinceLoad
                    }
                    className="h-10 gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    {'Delete (' + String(selectedBackups.size) + ')'}
                  </Button>
                </DisabledReason>
              )}
              <DisabledReason
                reason={
                  !canManageBackups
                    ? "Managing backups requires the backups.manage permission, which this role doesn't have."
                    : null
                }
              >
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteOlderDialog(true)}
                  disabled={
                    deletingOlder || backups.length === 0 || !canManageBackups
                  }
                  className="h-10 gap-2"
                >
                  {deletingOlder ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Clock className="w-4 h-4" />
                  )}
                  {'Delete Older'}
                </Button>
              </DisabledReason>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {backupStatus &&
          !backupStatus.savesExists &&
          backupsLoaded &&
          backups.length === 0 ? (
            <EmptyState
              type="empty"
              title={'No saves folder found'}
              description={
                "The panel couldn't find a Saves/Multiplayer folder for the active server. Set up a server if you haven't yet, or start it at least once — the folder is created on first launch."
              }
              action={{ label: 'Open Server Setup', to: '/server-setup' }}
            />
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : backups.length === 0 ? (
            <EmptyState
              type="noData"
              title={'No safety net'}
              description={
                'Create a backup before changing saves, mods, or server settings — one bad update away from lost progress.'
              }
              action={
                canManageBackups
                  ? {
                      label: 'Create Backup',
                      onClick: handleCreateBackup,
                      variant: 'default',
                    }
                  : undefined
              }
            />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-3 px-3 py-2.5 border border-border/50 bg-muted/20 rounded-lg">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  id="select-all"
                />
                <Label
                  htmlFor="select-all"
                  className="text-sm font-medium cursor-pointer flex-1"
                >
                  {selectedBackups.size === 0
                    ? Number(backups.length) === 1
                      ? 'Select all · ' + String(backups.length) + ' backup'
                      : 'Select all · ' + String(backups.length) + ' backups'
                    : allSelected
                      ? Number(backups.length) === 1
                        ? 'All ' +
                          String(backups.length) +
                          ' selected · click to clear'
                        : 'All ' +
                          String(backups.length) +
                          ' selected · click to clear'
                      : String(selectedBackups.size) +
                        ' of ' +
                        String(backups.length) +
                        ' selected'}
                </Label>
                {selectedBackups.size > 0 && (
                  <span className="inline-flex h-5 items-center rounded-full bg-primary/15 px-2 font-mono text-[11px] tabular-nums text-primary">
                    {selectedBackups.size}
                  </span>
                )}
              </div>

              <ScrollArea className="h-[300px] sm:h-[400px]">
                <div className="space-y-2 pe-4">
                  {backups.map((backup, idx) => {
                    const isSelected = selectedBackups.has(backup.name)
                    const isRestoring = restoringBackup === backup.name
                    const isLatest = idx === 0

                    return (
                      <div
                        key={backup.name}
                        className={cn(
                          'group/backup flex flex-col gap-3 p-3 rounded-lg border transition-colors sm:flex-row sm:items-center',
                          isSelected
                            ? 'border-primary/40 bg-primary/[0.08]'
                            : 'bg-muted/20 border-border/40 hover:border-primary/30 hover:bg-muted/40',
                        )}
                      >
                        <div className="flex flex-1 min-w-0 items-center gap-3">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() =>
                              toggleBackupSelection(backup.name)
                            }
                            disabled={isRestoring}
                            aria-label={'Select backup ' + String(backup.name)}
                          />

                          <div
                            className={cn(
                              'grid place-items-center w-9 h-9 rounded-md border shrink-0',
                              isLatest
                                ? 'border-primary/40 bg-primary/[0.08] text-primary'
                                : 'border-border/55 bg-muted/30 text-muted-foreground',
                            )}
                            aria-hidden="true"
                          >
                            <Archive className="w-4 h-4" />
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="font-medium text-sm text-foreground truncate">
                                {backup.name}
                              </p>
                              {isLatest && (
                                <span className="shrink-0 inline-flex h-5 items-center rounded-full bg-primary/15 px-2 text-[10px] font-medium uppercase tracking-wide text-primary">
                                  {'Latest'}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1 tabular-nums">
                                <HardDrive className="w-3 h-3" />
                                {formatBytes(backup.size)}
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatDate(backup.created)}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          <DisabledReason
                            reason={
                              !canManageBackups
                                ? "Managing backups requires the backups.manage permission, which this role doesn't have."
                                : null
                            }
                          >
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleViewSnapshot(backup.name)}
                              disabled={!canManageBackups}
                              className="h-9 w-9"
                              aria-label={
                                'View snapshot for ' + String(backup.name)
                              }
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={'View server snapshot'}
                            >
                              <FileText className="w-4 h-4" />
                            </Button>
                          </DisabledReason>
                          <DisabledReason
                            reason={
                              !canRestoreBackups
                                ? "Restoring a backup requires the backups.restore permission, which this role doesn't have."
                                : null
                            }
                          >
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openRestoreDialog(backup.name)}
                              disabled={
                                isRestoring ||
                                restoringBackup !== null ||
                                restoreInProgressElsewhere ||
                                creatingBackup ||
                                !canRestoreBackups ||
                                serverChangedSinceLoad
                              }
                              className="h-9 w-9 text-warning hover:text-warning hover:bg-warning/10"
                              aria-label={'Restore ' + String(backup.name)}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={'Restore this backup'}
                            >
                              {isRestoring ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <RotateCcw className="w-4 h-4" />
                              )}
                            </Button>
                          </DisabledReason>
                          <DisabledReason
                            reason={
                              !canDownloadBackups
                                ? "Downloading a backup requires the backups.download permission, which this role doesn't have."
                                : null
                            }
                          >
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                if (canDownloadBackups)
                                  backupApi.downloadBackup(backup.name)
                              }}
                              disabled={!canDownloadBackups}
                              className="h-9 w-9"
                              aria-label={'Download ' + String(backup.name)}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={'Download backup'}
                            >
                              <Download className="w-4 h-4" />
                            </Button>
                          </DisabledReason>
                          <DisabledReason
                            reason={
                              !canManageBackups
                                ? "Managing backups requires the backups.manage permission, which this role doesn't have."
                                : null
                            }
                          >
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setDeleteDialog({
                                  open: true,
                                  names: [backup.name],
                                })
                              }
                              disabled={
                                deletingBackups ||
                                !canManageBackups ||
                                serverChangedSinceLoad
                              }
                              className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                              aria-label={'Delete ' + String(backup.name)}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={'Delete backup'}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </DisabledReason>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={snapshotDialog !== null}
        onOpenChange={(open) => !open && setSnapshotDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{'Server Snapshot'}</AlertDialogTitle>
            <AlertDialogDescription>
              {snapshotDialog?.name}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {snapshotDialog && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                <span>{'Server'}</span>
                <span className="text-foreground">
                  {snapshotDialog.snapshot.server.name}
                </span>
                <span>{'Provider'}</span>
                <span className="text-foreground">
                  {snapshotDialog.snapshot.server.provider}
                </span>
                <span>{'Captured'}</span>
                <span className="text-foreground">
                  {new Date(snapshotDialog.snapshot.createdAt).toLocaleString(
                    'en',
                  )}
                </span>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {'SERVER.INI'}
                </p>
                <pre className="max-h-36 overflow-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">
                  {Object.entries(snapshotDialog.snapshot.serverIni)
                    .map(([key, value]) => `${key}=${value}`)
                    .join('\n') || 'No captured settings'}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {'SANDBOX'}
                </p>
                <pre className="max-h-36 overflow-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">
                  {Object.entries(snapshotDialog.snapshot.sandboxVars)
                    .map(([key, value]) => `${key}=${value}`)
                    .join('\n') || 'No captured settings'}
                </pre>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setSnapshotDialog(null)}>
              {'Close'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={restoreDialog.open}
        onOpenChange={(open) => setRestoreDialog({ open, backupName: null })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {'Restore Backup'}
              <HelpTip label={'Restore Backup'}>
                {
                  "Restoring only replaces this world's save files — your server settings, mods, and workshop items are untouched."
                }
              </HelpTip>
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                <>
                  {'Restore '}
                  <strong>{restoreDialog.backupName}</strong>
                  {' onto '}
                  <strong className="text-destructive">
                    {restoreTargetServerName || 'the currently active server'}
                  </strong>
                  {'. This will '}
                  <span className="font-medium text-destructive">
                    {'replace'}
                  </span>
                  {' the current world data.'}
                </>
              </p>
              <ul className="list-disc list-inside text-sm space-y-1 mt-2">
                <li>{'Stop the server first.'}</li>
                <li>
                  {'The panel will create a safety backup before restoring.'}
                </li>
                <li>
                  {
                    "Undoing this later means restoring that safety backup yourself — it won't happen automatically."
                  }
                </li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                restoreDialog.backupName &&
                handleRestoreBackup(restoreDialog.backupName)
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {'Restore this backup'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteDialog.open}
        onOpenChange={(open) => setDeleteDialog({ open, names: [] })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />
              {deleteDialog.names.length > 1
                ? 'Delete Backups'
                : 'Delete Backup'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDialog.names.length === 1 ? (
                <p>
                  <>
                    {'Delete '}
                    <strong>{deleteDialog.names[0]}</strong>
                    {'? This permanently removes the backup file.'}
                  </>
                </p>
              ) : (
                <p>
                  <>
                    {'Delete '}
                    <strong>
                      {deleteDialog.names.length}
                      {' backups'}
                    </strong>
                    {'? This permanently removes those files.'}
                  </>
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleDeleteBackups(deleteDialog.names)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteDialog.names.length > 1
                ? 'Delete backups'
                : 'Delete backup'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOlderDialog} onOpenChange={setDeleteOlderDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Clock className="w-5 h-5" />
              {'Delete Old Backups'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>
                  {
                    'Delete every backup older than the number of days you choose here.'
                  }
                </p>
                <div className="flex items-center gap-3">
                  <Label
                    htmlFor="delete-days"
                    className="text-foreground whitespace-nowrap"
                  >
                    {'Delete backups older than'}
                  </Label>
                  <NumberInput
                    id="delete-days"
                    min={1}
                    max={365}
                    value={deleteOlderDays}
                    onChange={setDeleteOlderDays}
                    onWheel={(e) => e.currentTarget.blur()}
                    className="w-20"
                  />
                  <span className="text-foreground">{'days'}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {'This permanently deletes backups created more than ' +
                    String(deleteOlderDays) +
                    ' days ago.'}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteOlderThan}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {'Delete older backups'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
