import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { ApiError, panelUpdateApi, type PanelUpdatePreflight, type PanelUpdateStatus } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useSocket } from '@/contexts/SocketContext'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress'
import { toastManager } from '@/components/ui/toast'
import type { AppSettingsState } from './useAppSettings'

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

const EMPTY_STATUS: PanelUpdateStatus = {
  currentVersion: 'Unknown',
  updateAvailable: true,
  latestVersion: null,
  releaseUrl: null,
  releaseNotes: null,
  publishedAt: null,
  isChecking: false,
  isDownloading: false,
  downloadProgress: 0,
  lastCheck: null,
  lastError: null,
  stagedUpdate: null,
  lastApplyResult: null,
}

function PanelUpdates({ isDirty }: { isDirty: boolean }) {
  const socket = useSocket()
  const [status, setStatus] = useState<PanelUpdateStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [preflight, setPreflight] = useState<PanelUpdatePreflight | null>(null)
  const [resultDismissed, setResultDismissed] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      setStatus(await panelUpdateApi.getStatus())
      setStatusError(null)
    } catch (error) {
      setStatusError(getUserErrorMessage(error, 'Could not load updater status'))
      reportClientError('Failed to fetch panel update status.', error)
    }
  }, [])

  const fetchPreflight = useCallback(async () => {
    try {
      const result = await panelUpdateApi.preflight()
      setPreflight(result)
      return result
    } catch (error) {
      reportClientError('Failed to fetch panel update preflight.', error)
      return null
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const actionable = Boolean(status?.updateAvailable || status?.stagedUpdate)
  const isDocker = status?.updateMode === 'docker'
  const stagedPath = status?.stagedUpdate?.path

  useEffect(() => {
    if (actionable) void fetchPreflight()
  }, [actionable, stagedPath, fetchPreflight])

  useEffect(() => {
    if (!socket) return
    const onAvailable = (data: { latestVersion?: string; currentVersion?: string; releaseUrl?: string }) =>
      setStatus((prev) => {
        const base = prev ?? { ...EMPTY_STATUS, currentVersion: data.currentVersion || 'Unknown', lastCheck: new Date().toISOString() }
        return {
          ...base,
          updateAvailable: true,
          latestVersion: data.latestVersion || base.latestVersion,
          currentVersion: data.currentVersion || base.currentVersion,
          releaseUrl: data.releaseUrl || base.releaseUrl,
          lastError: null,
        }
      })
    const onProgress = (data: { progress?: number; status?: string }) =>
      setStatus((prev) => {
        const base = prev ?? EMPTY_STATUS
        return {
          ...base,
          isDownloading: data.status === 'downloading' || data.status === 'preparing',
          downloadProgress: Math.max(0, Math.min(100, data.progress ?? base.downloadProgress)),
        }
      })
    socket.on('panel:updateAvailable', onAvailable)
    socket.on('panel:downloadProgress', onProgress)
    return () => {
      socket.off('panel:updateAvailable', onAvailable)
      socket.off('panel:downloadProgress', onProgress)
    }
  }, [socket])

  const check = async () => {
    setChecking(true)
    setStatusError(null)
    try {
      const next = await panelUpdateApi.check()
      setStatus(next)
      toastManager.add(
        next.updateAvailable
          ? { title: 'Update available', description: `Version ${next.latestVersion} is out. You have ${next.currentVersion}.` }
          : { title: 'Up to date', description: `You're running the latest release (${next.currentVersion}).`, type: 'success' },
      )
    } catch (error) {
      toastManager.add({
        title: 'Update check failed',
        description: getUserErrorMessage(error, "The panel couldn't reach GitHub. Check your connection and try again."),
        type: 'error',
      })
    } finally {
      setChecking(false)
    }
  }

  const install = async () => {
    setConfirmOpen(false)
    setInstalling(true)
    setStatusError(null)
    try {
      const pre = await fetchPreflight()
      if (!pre?.ok) throw new Error(pre?.blockers[0] || 'The update is blocked by a preflight check.')
      const previous = await fetch('/api/health').then((response) => response.json())
      const previousResult = (await panelUpdateApi.getStatus()).lastApplyResult?.at
      await panelUpdateApi.install()
      setReconnecting(true)
      toastManager.add({ title: 'Updating the panel', description: 'Backing up panel data and restarting. Game servers stay online.' })
      const deadline = Date.now() + 300000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        try {
          const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(2000) })
          if (!response.ok) continue
          const health = await response.json()
          if (health.status === 'ok' && health.instanceId && health.instanceId !== previous.instanceId) {
            const result = (await panelUpdateApi.getStatus()).lastApplyResult
            if (!result?.at || result.at === previousResult) continue
            window.location.reload()
            return
          }
        } catch {
          // The panel is offline during the restart and a possible rollback.
        }
      }
      throw new Error('The panel has not reconnected. Check the panel log before trying again.')
    } catch (error) {
      setReconnecting(false)
      const data = error instanceof ApiError ? (error.data as { preflight?: PanelUpdatePreflight }) : undefined
      if (data?.preflight) setPreflight(data.preflight)
      toastManager.add({
        title: "The panel update didn't finish",
        description: getUserErrorMessage(error, 'Check network access, disk space and the panel log.'),
        type: 'error',
      })
      await fetchStatus()
    } finally {
      setInstalling(false)
    }
  }

  const busy = checking || installing || reconnecting
  const downloading = installing || status?.isDownloading
  const stateBadge = checking || status?.isChecking ? (
    <Badge variant="secondary">Checking…</Badge>
  ) : downloading ? (
    <Badge variant="info">Downloading…</Badge>
  ) : status?.updateAvailable ? (
    <Badge variant="warning">Update available</Badge>
  ) : statusError ? (
    <Badge variant="error">Can't reach the updater</Badge>
  ) : !status?.latestVersion ? (
    <Badge variant="secondary">Not checked</Badge>
  ) : (
    <Badge variant="success">Up to date</Badge>
  )
  const targetVersion = status?.stagedUpdate?.version || status?.latestVersion

  return (
    <SettingsCard
      title="Panel updates"
      description={
        isDocker
          ? 'Check for a new release, then update from the Docker host.'
          : 'Checks for a release, verifies the download, backs up panel data and restarts the panel.'
      }
      action={stateBadge}
    >
      <div className="grid gap-4 py-4">
        {statusError && (
          <Alert variant="error">
            <AlertTriangle />
            <AlertTitle>Updater error</AlertTitle>
            <AlertDescription className="break-words">{statusError}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={() => void fetchStatus()} disabled={busy}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          {[
            ['Installed', status?.currentVersion ? `v${status.currentVersion}` : 'Unknown'],
            ['Latest', status?.latestVersion ? `v${status.latestVersion}` : 'Not checked yet'],
            ['Last check', formatTimestamp(status?.lastCheck)],
            ['Released', formatTimestamp(status?.publishedAt)],
          ].map(([label, value]) => (
            <div key={label} className="grid gap-0.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>

        {downloading && (
          <Progress value={status?.downloadProgress ?? 0}>
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>Downloading the update</span>
              <span className="tabular-nums">{status?.downloadProgress ?? 0}%</span>
            </div>
            <ProgressTrack>
              <ProgressIndicator />
            </ProgressTrack>
          </Progress>
        )}

        {status?.lastError && (
          <Alert variant="error">
            <AlertTitle>Last update error</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap break-words">{status.lastError}</AlertDescription>
          </Alert>
        )}

        {status?.lastApplyResult && !resultDismissed && (
          <Alert variant={status.lastApplyResult.status === 'success' ? 'success' : 'error'} role="status">
            <AlertTitle>{status.lastApplyResult.status === 'success' ? 'Panel update complete' : 'Panel update failed'}</AlertTitle>
            <AlertDescription>
              {status.lastApplyResult.status === 'success'
                ? `Running v${status.currentVersion}. Game servers stayed online.`
                : status.lastApplyResult.message || 'The previous panel was restored. Check the panel log before retrying.'}
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="ghost" onClick={() => setResultDismissed(true)}>
                Dismiss
              </Button>
            </AlertAction>
          </Alert>
        )}

        {preflight && !preflight.ok && !isDocker && actionable && (
          <Alert variant="error">
            <AlertTriangle />
            <AlertTitle>Update blocked</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 ps-5">
                {preflight.blockers.map((blocker) => (
                  <li key={blocker} className="break-words">
                    {blocker}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {preflight?.ok && preflight.warnings.length > 0 && actionable && !(status?.lastApplyResult?.status === 'failed' && !resultDismissed) && (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertTitle>Before you restart</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 ps-5">
                {preflight.warnings.map((warning) => (
                  <li key={warning} className="break-words">
                    {warning}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {isDocker && status?.updateAvailable && status.updateCommand && (
          <div className="grid gap-2 text-sm">
            <p className="text-muted-foreground">Run this command on the Docker host to update the panel:</p>
            <code className="block overflow-x-auto rounded-lg border bg-muted p-3 font-mono text-sm select-all">{status.updateCommand}</code>
            {status.dockerInstallKind === 'aio' && (
              <p className="text-warning-foreground">
                This older combined container also runs Project Zomboid. Save and stop the game once before migrating with the host command.
              </p>
            )}
            {status.dockerInstallKind === 'split' && <p className="text-muted-foreground">This updates the panel container. Running game containers stay online.</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void check()} disabled={busy}>
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {checking ? 'Checking…' : 'Check for updates'}
          </Button>
          {!isDocker && (
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <Button disabled={!actionable || busy || isDirty || preflight?.ok === false} onClick={() => setConfirmOpen(true)}>
                {installing || reconnecting ? <Loader2 className="animate-spin" /> : <Download />}
                {reconnecting ? 'Reconnecting…' : installing ? 'Downloading…' : 'Update panel'}
              </Button>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Update panel to v{targetVersion}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The panel downloads and verifies the release, backs up its data and restarts. Your game servers stay online. If the new panel
                    fails its health check, the previous version and panel data are restored automatically.
                  </AlertDialogDescription>
                  {preflight?.warnings.length ? (
                    <ul className="mt-2 list-disc ps-5 text-sm text-muted-foreground">
                      {preflight.warnings.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  ) : null}
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
                  <Button onClick={() => void install()}>Update now</Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          )}
          {status?.releaseUrl && (
            <Button variant="ghost" render={<a href={status.releaseUrl} target="_blank" rel="noopener noreferrer" />}>
              <ExternalLink />
              Release notes
              <span className="sr-only">(opens in new tab)</span>
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {isDirty
            ? 'Save your settings before applying an update.'
            : isDocker
              ? 'Docker updates are started by the host operator.'
              : 'Native packages update in one click. Source checkouts update with git.'}
        </p>
      </div>
    </SettingsCard>
  )
}

export function UpdatesSection({ state }: { state: AppSettingsState }) {
  const { settings, update, isDirty } = state
  return (
    <div className="grid gap-4">
      <PanelUpdates isDirty={isDirty} />
      <SettingsCard title="Game updates" description="Game servers are updated from each server's settings page.">
        <SettingsRow
          label="SteamCMD account"
          htmlFor="steam-update-account"
          description="Use a Steam account that owns Project Zomboid when anonymous updates can't reach a depot. Only the account name is saved; SteamCMD keeps its own encrypted session and may ask for Steam Guard again."
        >
          <Input
            id="steam-update-account"
            className="w-64"
            value={settings.steamUpdateAccount}
            onChange={(e) => update('steamUpdateAccount', e.target.value)}
            placeholder="Anonymous"
            autoComplete="username"
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  )
}
