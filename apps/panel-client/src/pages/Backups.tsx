import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { backupApi, serversApi, BackupSnapshot, type ServerBackupArchive } from '@/lib/api'
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
  const { t, i18n } = useTranslation('backups')
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
    queryKey: activeServerId == null ? ['backups', 'history', 'none'] : panelQueryKeys.backupHistory(activeServerId),
    queryFn: () => backupApi.getHistory(activeServerId as string | number),
    enabled: activeServerId != null,
    retry: false,
    staleTime: 15_000,
  })
  const history = historyQuery.data?.records ?? []
  const loading = activeServerFetching || backupStatusFetching || backupsFetching
  const loadError = backupStatusError
    ? getUserErrorMessage(backupStatusError, t('toasts.loadStatusFailed'))
    : backupsError
      ? getUserErrorMessage(backupsError, t('toasts.loadBackupsFailed'))
      : null
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
  const [deletingBackups, setDeletingBackups] = useState(false)
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null)
  const [uploadingBackup, setUploadingBackup] = useState(false)
  const [uploadPercent, setUploadPercent] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [serverChangedSinceLoad, setServerChangedSinceLoad] = useState(false)
  const [restoreTargetServerName, setRestoreTargetServerName] = useState<string | null>(null)

  const [selectedBackups, setSelectedBackups] = useState<Set<string>>(new Set())

  const [showSettings, setShowSettings] = useState(false)
  const [backupSchedule, setBackupSchedule] = useState('0 */6 * * *')
  const [backupMaxCount, setBackupMaxCount] = useState(10)
  const [savingSettings, setSavingSettings] = useState(false)

  const [restoreDialog, setRestoreDialog] = useState<{ open: boolean; backupName: string | null }>({
    open: false,
    backupName: null,
  })
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; names: string[] }>({
    open: false,
    names: [],
  })
  const [deleteOlderDialog, setDeleteOlderDialog] = useState(false)
  const [deleteOlderDays, setDeleteOlderDays] = useState(7)
  const [deletingOlder, setDeletingOlder] = useState(false)
  const [snapshotDialog, setSnapshotDialog] = useState<{ name: string; snapshot: BackupSnapshot } | null>(null)

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
        progressTimeoutRef.current = setTimeout(() => setBackupProgress(null), 2000)
      } else if (data.phase === 'error') {
        setCreatingBackup(false)
        progressTimeoutRef.current = setTimeout(() => setBackupProgress(null), 3000)
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
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
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
    setBackupProgress({ phase: 'preparing', percent: 0, message: t('progress.startingFallback') })
    try {
      const result = await backupApi.createBackup()
      if (result.success && result.backup) {
        toast({
          title: t('toasts.backupCreatedTitle'),
          description: t('toasts.backupCreatedDesc', { name: result.backup.name, seconds: result.duration?.toFixed(1) }),
          variant: 'success' as const,
        })
        await fetchBackups()
        await fetchBackupStatus()
      } else {
        throw new Error(result.message || t('toasts.createBackupFailedFallback'))
      }
    } catch (error) {
      toast({
        title: t('toasts.backupFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.createBackupFailedFallback')),
        variant: 'destructive',
      })
      setBackupProgress({ phase: 'error', percent: 0, message: t('toasts.backupFailedMessage') })
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
      }
      progressTimeoutRef.current = setTimeout(() => setBackupProgress(null), 3000)
    } finally {
      setCreatingBackup(false)
      ownBackupInFlightRef.current = false
    }
  }

  const handleUploadFile = async (file: File) => {
    if (!canManageBackups) return
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    if (!file) return
    if (activeServerRemote) {
      toast({ title: t('toasts.notAvailableRemoteTitle'), description: t('toasts.notAvailableRemoteDesc'), variant: 'destructive' })
      return
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast({ title: t('toasts.invalidFileTitle'), description: t('toasts.invalidFileDesc'), variant: 'destructive' })
      return
    }
    const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({ title: t('toasts.fileTooLargeTitle'), description: t('toasts.fileTooLargeDesc', { size: (file.size / (1024 * 1024 * 1024)).toFixed(2) }), variant: 'destructive' })
      return
    }
    if (file.size === 0) {
      toast({ title: t('toasts.emptyFileTitle'), description: t('toasts.emptyFileDesc'), variant: 'destructive' })
      return
    }
    setUploadingBackup(true)
    setUploadPercent(0)
    try {
      const result = await backupApi.uploadBackup(file, setUploadPercent)
      toast({
        title: t('toasts.uploadedTitle'),
        description: t('toasts.uploadedDesc', { name: result.name }),
        variant: 'success' as const,
      })
      await fetchBackups()
      await fetchBackupStatus()
    } catch (error) {
      toast({
        title: t('toasts.uploadFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.uploadFailedFallback')),
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
    setRestoreTargetServerName(activeServer?.name || activeServer?.serverName || null)
  }

  const handleRestoreBackup = async (name: string) => {
    if (!canRestoreBackups) return
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    setRestoreDialog({ open: false, backupName: null })
    setRestoringBackup(name)
    try {
      const result = await backupApi.restoreBackup(name, { createPreRestoreBackup: true })
      toast({
        title: t('toasts.restoredTitle'),
        description: t('toasts.restoredDesc', { name, seconds: (result.duration || 0).toFixed(1) }),
        variant: 'success' as const,
      })
      await fetchBackups()
    } catch (error) {
      toast({
        title: t('toasts.restoreFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.restoreFailedFallback')),
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
      if (!result.success || !result.snapshot) throw new Error(result.message || t('toasts.snapshotMissingFallback'))
      setSnapshotDialog({ name, snapshot: result.snapshot })
    } catch (error) {
      toast({
        title: t('toasts.snapshotUnavailableTitle'),
        description: getUserErrorMessage(error, t('toasts.snapshotUnavailableFallback')),
        variant: 'destructive',
      })
    }
  }

  const handleDeleteBackups = async (names: string[]) => {
    if (!canManageBackups) return
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
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
          title: t('toasts.oldSnapshotsClearedTitle'),
          description: t('toasts.oldSnapshotsClearedDesc', { count: successCount })
            + (failCount > 0 ? t('toasts.oldSnapshotsClearedFailSuffix', { count: failCount }) : ''),
          variant: 'success' as const,
        })
      }
      if (failCount > 0 && successCount === 0) {
        toast({
          title: t('toasts.deleteFailedTitle'),
          description: t('toasts.deleteFailedCount', { count: failCount }),
          variant: 'destructive',
        })
      }

      setSelectedBackups(new Set())
      await fetchBackups()
    } catch (error) {
      toast({
        title: t('toasts.deleteFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.deleteFailedFallback')),
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
        title: t('toasts.oldBackupsRemovedTitle'),
        description: result.message || t('toasts.oldBackupsRemovedFallback', { count: result.deleted || 0 }),
        variant: 'success' as const,
      })
      await fetchBackups()
    } catch (error) {
      toast({
        title: t('toasts.deleteFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.deleteOldFailedFallback')),
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
        title: t('toasts.planUpdatedTitle'),
        description: t('toasts.planUpdatedDesc'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.planUpdateFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.planUpdateFailedFallback')),
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
        title: enabled ? t('toasts.autoArmedTitle') : t('toasts.autoStoodDownTitle'),
        description: enabled ? t('toasts.autoArmedDesc') : t('toasts.autoStoodDownDesc'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.autoUpdateFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.autoUpdateFailedFallback')),
        variant: 'destructive',
      })
    }
  }

  const toggleBackupSelection = (name: string) => {
    setSelectedBackups(prev => {
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
      setSelectedBackups(new Set(backups.map(b => b.name)))
    }
  }

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr)
    return date.toLocaleDateString(i18n.language) + ' ' + date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
  }

  const lastScheduledAttemptFailed = Boolean(
    backupStatus?.enabled && backupStatus?.lastScheduledBackupAttempt && !backupStatus.lastScheduledBackupAttempt.success
  )

  const describeSchedule = (cron: string | undefined): string => {
    if (!cron) return t('schedule.none')
    const map: Record<string, string> = {
      '*/15 * * * *': t('schedule.every15Min'),
      '*/30 * * * *': t('schedule.every30Min'),
      '0 * * * *': t('schedule.everyHour'),
      '0 */2 * * *': t('schedule.every2Hours'),
      '0 */4 * * *': t('schedule.every4Hours'),
      '0 */6 * * *': t('schedule.every6Hours'),
      '0 */8 * * *': t('schedule.every8Hours'),
      '0 */12 * * *': t('schedule.every12Hours'),
      '0 0 * * *': t('schedule.dailyMidnight'),
      '0 6 * * *': t('schedule.daily6am'),
      '0 12 * * *': t('schedule.dailyNoon'),
      '0 18 * * *': t('schedule.daily6pm'),
    }
    return map[cron] || cron
  }

  const totalSize = useMemo(() => {
    return backups.reduce((sum, b) => sum + b.size, 0)
  }, [backups])

  const isAnySelected = selectedBackups.size > 0
  const allSelected = backups.length > 0 && selectedBackups.size === backups.length

  const restoreInProgressElsewhere = restoringBackup === null && Boolean(backupStatus?.restoreInProgress)

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        icon={<Archive className="w-5 h-5 text-primary" />}
        actions={
          <>
            <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : activeServerRemote ? t('pageHeader.remoteDisabledTitle') : null}>
              <Button
                onClick={handleCreateBackup}
                disabled={creatingBackup || restoringBackup !== null || restoreInProgressElsewhere || !backupStatus?.savesExists || activeServerRemote || !canManageBackups || serverChangedSinceLoad}
                className="gap-2"
              >
                {creatingBackup ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Archive className="w-4 h-4" />
                )}
                {creatingBackup ? t('pageHeader.creating') : t('pageHeader.createBackup')}
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
            <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : activeServerRemote ? t('pageHeader.uploadTitleRemote') : null}>
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingBackup || restoringBackup !== null || restoreInProgressElsewhere || activeServerRemote || !canManageBackups || serverChangedSinceLoad}
                className="gap-2"
                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Upload an existing world_backup_*.zip from another machine"); the actual disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                title={t('pageHeader.uploadTitleLocal')}
              >
                {uploadingBackup ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                {uploadingBackup ? t('pageHeader.uploading', { percent: uploadPercent }) : t('pageHeader.uploadZip')}
              </Button>
            </DisabledReason>
            <Button
              variant="outline"
              onClick={() => setShowSettings(!showSettings)}
              className="gap-2"
            >
              <Settings className="w-4 h-4" />
              {t('pageHeader.settings')}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={refreshAll}
              disabled={loading}
              aria-label={t('pageHeader.refreshAria')}
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; disables only transiently while a refresh is already in flight (the spinning icon is the self-evident "why"), not a permission gate needing DisabledReason. Triaged 2026-08-27.
              title={t('pageHeader.refreshTitle')}
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            </Button>
          </>
        }
      />

      {loadError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('alerts.loadErrorTitle')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={refreshAll} className="self-start sm:self-auto">
              <RefreshCw className="me-2 h-4 w-4" />
              {t('alerts.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {activeServerRemote && (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle>{t('alerts.remoteTitle')}</AlertTitle>
          <AlertDescription>
            {t('alerts.remoteDesc')}
          </AlertDescription>
        </Alert>
      )}

      {activeServerId != null && history.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-border/50 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t('history.label')}</span>
          <span>{t('history.recordedCount', { count: history.length })}</span>
          <span>{t('history.latest', { date: formatDate(history[0].createdAt) })}</span>
          <span className="font-mono">{history[0].fileName}</span>
        </div>
      )}

      {backups.length > 0 && (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger-in">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="grid place-items-center w-10 h-10 rounded-md border border-primary/30 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
              <Archive className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('statusCards.totalBackups')}</p>
              <p className="text-xl font-semibold leading-tight mt-0.5 text-foreground">{backups.length}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="grid place-items-center w-10 h-10 rounded-md border border-border/55 bg-muted/30 text-muted-foreground shrink-0" aria-hidden="true">
              <HardDrive className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('statusCards.totalSize')}</p>
              <p className="text-xl font-semibold leading-tight mt-0.5 text-foreground tabular-nums">{formatBytes(totalSize)}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="grid place-items-center w-10 h-10 rounded-md border border-primary/30 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
              <Clock className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('statusCards.lastBackup')}</p>
              <p className="text-sm font-semibold leading-tight mt-0.5 text-foreground truncate">
                {backupStatus?.lastBackup ? formatDate(backupStatus.lastBackup.created) : t('statusCards.never')}
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
                  : 'border-border/55 bg-muted/30 text-muted-foreground'
              )}
              aria-hidden="true"
            >
              {lastScheduledAttemptFailed ? <AlertTriangle className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('statusCards.autoBackup')}</p>
              <p className={cn('text-sm font-semibold leading-tight mt-0.5 truncate', backupStatus?.enabled ? 'text-foreground' : 'text-muted-foreground')}>
                {backupStatus?.enabled ? t('statusCards.on') : t('statusCards.off')}
              </p>
              {lastScheduledAttemptFailed ? (
                <p
                  className="text-[11px] text-amber-600 dark:text-amber-400 truncate"
                  title={backupStatus?.lastScheduledBackupAttempt?.message || ''}
                >
                  {t('statusCards.lastScheduledAttemptFailed', {
                    time: formatDate(backupStatus!.lastScheduledBackupAttempt!.executedAt),
                    message: backupStatus?.lastScheduledBackupAttempt?.message || '',
                  })}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground/80 truncate" title={backupStatus?.schedule || ''}>
                  {backupStatus?.enabled
                    ? t('statusCards.runsSchedule', { schedule: describeSchedule(backupStatus?.schedule), count: backupStatus?.maxBackups ?? '?' })
                    : t('statusCards.noScheduled')}
                </p>
              )}
            </div>
            <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
              <Switch
                checked={backupStatus?.enabled || false}
                onCheckedChange={toggleBackupEnabled}
                disabled={!canManageBackups}
                aria-label={t('statusCards.toggleAria')}
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
              {t('settingsPanel.title')}
            </CardTitle>
            <CardDescription>{t('settingsPanel.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="backup-schedule">{t('settingsPanel.frequencyLabel')}</Label>
                <Select value={backupSchedule} onValueChange={setBackupSchedule}>
                  <SelectTrigger id="backup-schedule" className="w-full">
                    <SelectValue placeholder={t('settingsPanel.frequencyPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="*/15 * * * *">{t('schedule.every15Min')}</SelectItem>
                    <SelectItem value="*/30 * * * *">{t('schedule.every30Min')}</SelectItem>
                    <SelectItem value="0 * * * *">{t('schedule.everyHour')}</SelectItem>
                    <SelectItem value="0 */2 * * *">{t('schedule.every2Hours')}</SelectItem>
                    <SelectItem value="0 */4 * * *">{t('schedule.every4Hours')}</SelectItem>
                    <SelectItem value="0 */6 * * *">{t('schedule.every6Hours')}</SelectItem>
                    <SelectItem value="0 */8 * * *">{t('schedule.every8Hours')}</SelectItem>
                    <SelectItem value="0 */12 * * *">{t('schedule.every12Hours')}</SelectItem>
                    <SelectItem value="0 0 * * *">{t('schedule.dailyMidnight')}</SelectItem>
                    <SelectItem value="0 6 * * *">{t('schedule.daily6am')}</SelectItem>
                    <SelectItem value="0 12 * * *">{t('schedule.dailyNoon')}</SelectItem>
                    <SelectItem value="0 18 * * *">{t('schedule.daily6pm')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('settingsPanel.frequencyHelp')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="backup-max">{t('settingsPanel.maxBackupsLabel')}</Label>
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
                  {t('settingsPanel.maxBackupsHelp')}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-xs text-muted-foreground">
                {backupStatus?.savesPath && (
                  <span className="flex flex-wrap items-center gap-1 break-all">
                    <FolderOpen className="w-3 h-3" />
                    {t('settingsPanel.savesLabel', { path: backupStatus.savesPath })}
                  </span>
                )}
              </div>
              <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                <Button onClick={handleSaveSettings} disabled={savingSettings || !canManageBackups} size="sm" className="h-10 gap-2 self-start sm:self-auto">
                  {savingSettings && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                  {t('settingsPanel.saveButton')}
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
                <p className="font-medium truncate">{t('restoreProgress.title', { name: restoringBackup })}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('restoreProgress.note')}</p>
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
                    {backupProgress?.message || t('progress.creatingFallback')}
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
              <CardTitle className="text-lg">{t('mainCard.title')}</CardTitle>
              {!backupStatus?.savesExists && (
                <span className="flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle className="w-3 h-3" />
                  {t('mainCard.savesNotFound')}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isAnySelected && (
                <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setDeleteDialog({ open: true, names: Array.from(selectedBackups) })}
                    disabled={deletingBackups || !canManageBackups || serverChangedSinceLoad}
                    className="h-10 gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    {t('mainCard.deleteSelected', { count: selectedBackups.size })}
                  </Button>
                </DisabledReason>
              )}
              <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteOlderDialog(true)}
                  disabled={deletingOlder || backups.length === 0 || !canManageBackups}
                  className="h-10 gap-2"
                >
                  {deletingOlder ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Clock className="w-4 h-4" />
                  )}
                  {t('mainCard.deleteOlder')}
                </Button>
              </DisabledReason>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {backupStatus && !backupStatus.savesExists && backupsLoaded && backups.length === 0 ? (
            <EmptyState
              type="empty"
              title={t('mainCard.noSavesFolderTitle')}
              description={t('mainCard.noSavesFolderDesc')}
              action={{ label: t('mainCard.noSavesFolderAction'), to: '/server-setup' }}
            />
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : backups.length === 0 ? (
            <EmptyState type="noData" title={t('mainCard.emptyTitle')} description={t('mainCard.emptyDesc')} action={canManageBackups ? { label: t('mainCard.emptyAction'), onClick: handleCreateBackup, variant: 'default' } : undefined} />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-3 px-3 py-2.5 border border-border/50 bg-muted/20 rounded-lg">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  id="select-all"
                />
                <Label htmlFor="select-all" className="text-sm font-medium cursor-pointer flex-1">
                  {selectedBackups.size === 0
                    ? t('mainCard.selectAllLabel', { count: backups.length })
                    : allSelected
                      ? t('mainCard.allSelectedLabel', { count: backups.length })
                      : t('mainCard.partialSelectedLabel', { selected: selectedBackups.size, total: backups.length })}
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
                            : 'bg-muted/20 border-border/40 hover:border-primary/30 hover:bg-muted/40'
                        )}
                      >
                        <div className="flex flex-1 min-w-0 items-center gap-3">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleBackupSelection(backup.name)}
                            disabled={isRestoring}
                            aria-label={t('mainCard.selectBackupAria', { name: backup.name })}
                          />

                          <div
                            className={cn(
                              'grid place-items-center w-9 h-9 rounded-md border shrink-0',
                              isLatest
                                ? 'border-primary/40 bg-primary/[0.08] text-primary'
                                : 'border-border/55 bg-muted/30 text-muted-foreground'
                            )}
                            aria-hidden="true"
                          >
                            <Archive className="w-4 h-4" />
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="font-medium text-sm text-foreground truncate">{backup.name}</p>
                              {isLatest && (
                                <span className="shrink-0 inline-flex h-5 items-center rounded-full bg-primary/15 px-2 text-[10px] font-medium uppercase tracking-wide text-primary">
                                  {t('mainCard.latestBadge')}
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
                          <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleViewSnapshot(backup.name)}
                              disabled={!canManageBackups}
                              className="h-9 w-9"
                              aria-label={t('mainCard.viewSnapshotAria', { name: backup.name })}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={t('mainCard.viewSnapshotTitle')}
                            >
                              <FileText className="w-4 h-4" />
                            </Button>
                          </DisabledReason>
                          <DisabledReason reason={!canRestoreBackups ? t('permissions.noRestore') : null}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openRestoreDialog(backup.name)}
                              disabled={isRestoring || restoringBackup !== null || restoreInProgressElsewhere || creatingBackup || !canRestoreBackups || serverChangedSinceLoad}
                              className="h-9 w-9 text-warning hover:text-warning hover:bg-warning/10"
                              aria-label={t('mainCard.restoreAria', { name: backup.name })}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={t('mainCard.restoreTitle')}
                            >
                              {isRestoring ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <RotateCcw className="w-4 h-4" />
                              )}
                            </Button>
                          </DisabledReason>
                          <DisabledReason reason={!canDownloadBackups ? t('permissions.noDownload') : null}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => { if (canDownloadBackups) backupApi.downloadBackup(backup.name) }}
                              disabled={!canDownloadBackups}
                              className="h-9 w-9"
                              aria-label={t('mainCard.downloadAria', { name: backup.name })}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={t('mainCard.downloadTitle')}
                            >
                              <Download className="w-4 h-4" />
                            </Button>
                          </DisabledReason>
                          <DisabledReason reason={!canManageBackups ? t('permissions.noManage') : null}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteDialog({ open: true, names: [backup.name] })}
                              disabled={deletingBackups || !canManageBackups || serverChangedSinceLoad}
                              className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                              aria-label={t('mainCard.deleteAria', { name: backup.name })}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                              title={t('mainCard.deleteTitle')}
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

      <AlertDialog open={snapshotDialog !== null} onOpenChange={(open) => !open && setSnapshotDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('snapshotDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{snapshotDialog?.name}</AlertDialogDescription>
          </AlertDialogHeader>
          {snapshotDialog && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                <span>{t('snapshotDialog.serverLabel')}</span><span className="text-foreground">{snapshotDialog.snapshot.server.name}</span>
                <span>{t('snapshotDialog.providerLabel')}</span><span className="text-foreground">{snapshotDialog.snapshot.server.provider}</span>
                <span>{t('snapshotDialog.capturedLabel')}</span><span className="text-foreground">{new Date(snapshotDialog.snapshot.createdAt).toLocaleString(i18n.language)}</span>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t('snapshotDialog.serverIniLabel')}</p>
                <pre className="max-h-36 overflow-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">{Object.entries(snapshotDialog.snapshot.serverIni).map(([key, value]) => `${key}=${value}`).join('\n') || t('snapshotDialog.noSettings')}</pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t('snapshotDialog.sandboxLabel')}</p>
                <pre className="max-h-36 overflow-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">{Object.entries(snapshotDialog.snapshot.sandboxVars).map(([key, value]) => `${key}=${value}`).join('\n') || t('snapshotDialog.noSettings')}</pre>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setSnapshotDialog(null)}>{t('snapshotDialog.close')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={restoreDialog.open} onOpenChange={(open) => setRestoreDialog({ open, backupName: null })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {t('restoreDialog.title')}
              <HelpTip label={t('restoreDialog.title')}>{t('restoreDialog.scopeTip')}</HelpTip>
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                <Trans
                  i18nKey="restoreDialog.description"
                  t={t}
                  values={{
                    name: restoreDialog.backupName,
                    serverName: restoreTargetServerName || t('restoreDialog.unknownServerFallback'),
                  }}
                  components={{
                    1: <strong />,
                    2: <span className="font-medium text-destructive" />,
                    3: <strong className="text-destructive" />,
                  }}
                />
              </p>
              <ul className="list-disc list-inside text-sm space-y-1 mt-2">
                <li>{t('restoreDialog.bulletStopServer')}</li>
                <li>{t('restoreDialog.bulletSafetyBackup')}</li>
                <li>{t('restoreDialog.bulletUndoRequiresRestore')}</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('restoreDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => restoreDialog.backupName && handleRestoreBackup(restoreDialog.backupName)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('restoreDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => setDeleteDialog({ open, names: [] })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />
              {deleteDialog.names.length > 1 ? t('deleteDialog.titlePlural') : t('deleteDialog.titleSingle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDialog.names.length === 1 ? (
                <p>
                  <Trans
                    i18nKey="deleteDialog.descSingle"
                    t={t}
                    values={{ name: deleteDialog.names[0] }}
                    components={{ 1: <strong /> }}
                  />
                </p>
              ) : (
                <p>
                  <Trans
                    i18nKey="deleteDialog.descPlural"
                    t={t}
                    values={{ count: deleteDialog.names.length }}
                    components={{ 1: <strong /> }}
                  />
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleDeleteBackups(deleteDialog.names)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteDialog.names.length > 1 ? t('deleteDialog.confirmPlural') : t('deleteDialog.confirmSingle')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOlderDialog} onOpenChange={setDeleteOlderDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Clock className="w-5 h-5" />
              {t('deleteOlderDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>{t('deleteOlderDialog.description')}</p>
                <div className="flex items-center gap-3">
                  <Label htmlFor="delete-days" className="text-foreground whitespace-nowrap">{t('deleteOlderDialog.olderThanLabel')}</Label>
                  <NumberInput
                    id="delete-days"
                    min={1}
                    max={365}
                    value={deleteOlderDays}
                    onChange={setDeleteOlderDays}
                    onWheel={(e) => e.currentTarget.blur()}
                    className="w-20"
                  />
                  <span className="text-foreground">{t('deleteOlderDialog.daysUnit')}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('deleteOlderDialog.warningWithDays', { days: deleteOlderDays })}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deleteOlderDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteOlderThan}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('deleteOlderDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
