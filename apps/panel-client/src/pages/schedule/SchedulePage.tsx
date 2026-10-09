import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Loader2, MoreHorizontal, Pencil, Play, Plus, RefreshCw, RotateCcw, Trash2, XCircle } from 'lucide-react'
import { backupApi, modsApi, schedulerApi, serversApi, type ScheduleHistoryEntry, type ServerInstance } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useConfirm } from '@/contexts/ConfirmContext'
import { EmptyState } from '@/components/EmptyState'
import { NumberInput } from '@/components/NumberInput'
import { PageHeader } from '@/components/PageHeader'
import { PageLoading } from '@/components/PageLoading'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { useShell } from '@/components/shell/useShellStatus'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toastManager } from '@/components/ui/toast'
import { describeBackupSchedule } from '../backups/BackupsPage'
import { describeCron, TaskDialog, type ScheduledTask } from './TaskDialog'
import { TimezoneField } from './TimezoneField'
import { WaitPolicyFields, type WaitPolicy } from './WaitPolicyFields'

const HISTORY_LIMIT = 50
const LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: 'Chinese (Simplified)' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'es', label: 'Spanish' },
  { value: 'ht', label: 'Haitian Creole' },
] as const
type Locale = (typeof LOCALES)[number]['value']

const BACKUP_SCHEDULES = ['*/15 * * * *', '*/30 * * * *', '0 * * * *', '0 */2 * * *', '0 */4 * * *', '0 */6 * * *', '0 */8 * * *', '0 */12 * * *', '0 0 * * *', '0 6 * * *', '0 12 * * *', '0 18 * * *'].map((cron) => ({
  value: cron,
  label: describeBackupSchedule(cron),
}))

interface SchedulerStatus {
  timezone?: string
  configuredTimezone?: string | null
  timezoneFallback?: { configured: string; effective: string } | null
  restartWarning?: { locale: Locale; template: string }
  restartWarningPresets?: Record<Locale, string>
}

function RestartNow({ running }: { running: boolean }) {
  const confirm = useConfirm()
  const [minutes, setMinutes] = useState(5)
  const [busy, setBusy] = useState(false)

  const restart = async (requested: number) => {
    const ok = await confirm({
      title: `Restart in ${requested} minute${requested === 1 ? '' : 's'}?`,
      description:
        requested < 5
          ? 'Short countdowns can catch players mid-fight or mid-drive. Everyone is disconnected when the countdown ends.'
          : 'Players get countdown warnings, then everyone is disconnected while the server restarts.',
      confirmLabel: 'Start countdown',
      destructive: false,
      variant: 'warning',
    })
    if (!ok) return
    setBusy(true)
    try {
      const { warningMinutes } = await schedulerApi.restartNow(requested)
      toastManager.add(
        warningMinutes !== requested
          ? { title: 'Restart scheduled', description: `The countdown is capped at ${warningMinutes} minutes, so the server restarts in ${warningMinutes}.`, type: 'warning' }
          : { title: 'Restart scheduled', description: `The server restarts in ${warningMinutes} minute${warningMinutes === 1 ? '' : 's'}.`, type: 'success' },
      )
    } catch (error) {
      toastManager.add({ title: "The restart didn't start", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard title="Restart now" description={running ? 'Players see warnings at 15, 10, 5 and 1 minutes as the countdown runs.' : 'The server is stopped. Start it before restarting.'}>
      <SettingsRow label="With a countdown">
        <div className="flex flex-wrap items-center gap-2">
          {[15, 10, 5, 1].map((value) => (
            <Button key={value} size="sm" variant="outline" disabled={busy || !running} onClick={() => void restart(value)}>
              {value} min
            </Button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <NumberInput className="w-20" min={1} max={30} value={minutes} onChange={setMinutes} aria-label="Custom countdown in minutes" />
          <Button size="sm" disabled={busy || !running || !Number.isFinite(minutes)} onClick={() => void restart(minutes)}>
            {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Restart
          </Button>
        </div>
      </SettingsRow>
    </SettingsCard>
  )
}

function AutomaticBackups() {
  const [enabled, setEnabled] = useState(false)
  const [schedule, setSchedule] = useState('0 */6 * * *')
  const [policy, setPolicy] = useState<WaitPolicy>({ waitMinutes: 60, force: false, warningMinutes: 15 })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const status = await backupApi.getStatus()
      setEnabled(status.enabled)
      setSchedule(status.schedule)
      setPolicy({ waitMinutes: status.forceAfterMinutes ?? status.waitMinutes ?? 60, force: status.forceAfterMinutes !== null, warningMinutes: status.forceWarningMinutes })
      setLoaded(true)
    } catch (error) {
      reportClientError('Failed to load backup schedule.', error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (next: boolean) => {
    setEnabled(next)
    try {
      await backupApi.updateSettings({ enabled: next })
      toastManager.add({ title: next ? 'Automatic backups on' : 'Automatic backups off', type: 'success' })
    } catch (error) {
      setEnabled(!next)
      toastManager.add({ title: "Couldn't change automatic backups", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      await backupApi.updateSettings({
        schedule,
        waitMinutes: policy.waitMinutes,
        forceAfterMinutes: policy.force ? policy.waitMinutes : null,
        forceWarningMinutes: policy.warningMinutes,
      })
      toastManager.add({ title: 'Backup schedule saved', type: 'success' })
      await load()
    } catch (error) {
      toastManager.add({ title: "Couldn't save the backup schedule", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Automatic backups"
      description="Full backups stop the server, so they wait for it to empty first."
      action={<Switch checked={enabled} onCheckedChange={(next) => void toggle(next)} disabled={!loaded} aria-label="Automatic backups" />}
    >
      {enabled && (
        <>
          <SettingsRow label="How often">
            <Select items={BACKUP_SCHEDULES} value={schedule} onValueChange={(value) => setSchedule(String(value))}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {BACKUP_SCHEDULES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </SettingsRow>
          <WaitPolicyFields policy={policy} onChange={setPolicy} waitRange={[15, 1440]} action="Back up" />
          <div className="flex justify-end py-4">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </div>
        </>
      )}
    </SettingsCard>
  )
}

function ModUpdateRestarts() {
  const [enabled, setEnabled] = useState(false)
  const [policy, setPolicy] = useState<WaitPolicy>({ waitMinutes: 60, force: false, warningMinutes: 15 })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const status = (await modsApi.getStatus()) as { autoRestartEnabled?: boolean; restartWarningMinutes?: number; forceAfterDeadline?: boolean; maxDelayMinutes?: number }
      setEnabled(status.autoRestartEnabled === true)
      setPolicy({ waitMinutes: status.maxDelayMinutes ?? 60, force: status.forceAfterDeadline === true, warningMinutes: status.restartWarningMinutes ?? 15 })
      setLoaded(true)
    } catch (error) {
      reportClientError('Failed to load mod restart settings.', error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (next: boolean) => {
    setEnabled(next)
    try {
      await modsApi.setAutoRestart(next)
      toastManager.add({ title: next ? 'Restarts for mod updates on' : 'Restarts for mod updates off', type: 'success' })
    } catch (error) {
      setEnabled(!next)
      toastManager.add({ title: "Couldn't change the setting", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      await modsApi.setRestartOptions({ warningMinutes: policy.warningMinutes, forceAfterDeadline: policy.force, maxDelayMinutes: policy.waitMinutes })
      toastManager.add({ title: 'Mod update restarts saved', type: 'success' })
      await load()
    } catch (error) {
      toastManager.add({ title: "Couldn't save the settings", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Restart when mods update"
      description="When Workshop updates arrive, restart so the server downloads them."
      action={<Switch checked={enabled} onCheckedChange={(next) => void toggle(next)} disabled={!loaded} aria-label="Restart when mods update" />}
    >
      {enabled && (
        <>
          <WaitPolicyFields policy={policy} onChange={setPolicy} waitRange={[15, 120]} action="Restart" />
          <div className="flex justify-end py-4">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </div>
        </>
      )}
    </SettingsCard>
  )
}

function RestartMessages({ status, onSaved }: { status: SchedulerStatus | null; onSaved: (next: SchedulerStatus['restartWarning']) => void }) {
  const [locale, setLocale] = useState<Locale>('en')
  const [template, setTemplate] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (dirty || !status?.restartWarning) return
    setLocale(status.restartWarning.locale)
    setTemplate(status.restartWarning.template)
  }, [status?.restartWarning, dirty])

  const save = async () => {
    setSaving(true)
    try {
      const result = await schedulerApi.setRestartWarning({ locale, template })
      setDirty(false)
      setTemplate(result.restartWarning.template)
      onSaved(result.restartWarning)
      toastManager.add({ title: 'Restart messages saved', type: 'success' })
    } catch (error) {
      toastManager.add({ title: "Couldn't save restart messages", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard title="Restart messages" description="The countdown every player sees before an automatic restart.">
      <SettingsRow label="Language">
        <Select
          items={[...LOCALES]}
          value={locale}
          onValueChange={(value) => {
            setDirty(true)
            setLocale(value as Locale)
            setTemplate(status?.restartWarningPresets?.[value as Locale] || '')
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {LOCALES.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </SettingsRow>
      <SettingsRow label="Message" stacked description="Use {count} for the number and {unit} for minutes or seconds.">
        <Textarea
          value={template}
          maxLength={300}
          onChange={(e) => {
            setDirty(true)
            setTemplate(e.target.value)
          }}
        />
      </SettingsRow>
      <div className="flex justify-end gap-2 py-4">
        <Button
          size="sm"
          variant="ghost"
          disabled={saving || !status?.restartWarningPresets?.[locale]}
          onClick={() => {
            setDirty(true)
            setTemplate(status?.restartWarningPresets?.[locale] || '')
          }}
        >
          Use the default for this language
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving || !template.trim() || !dirty}>
          {saving && <Loader2 className="animate-spin" />}
          Save
        </Button>
      </div>
    </SettingsCard>
  )
}

export default function SchedulePage() {
  const confirm = useConfirm()
  const { runState } = useShell()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [history, setHistory] = useState<ScheduleHistoryEntry[]>([])
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [dialog, setDialog] = useState<{ open: boolean; task: ScheduledTask | null }>({ open: false, task: null })
  const [timezone, setTimezone] = useState('')
  const [savingTimezone, setSavingTimezone] = useState(false)

  const fetchData = useCallback(async () => {
    setError(null)
    try {
      const [tasksData, statusData, historyData, serversData] = await Promise.all([
        schedulerApi.getTasks(),
        schedulerApi.getStatus().catch(() => null),
        schedulerApi.getHistory(HISTORY_LIMIT).catch(() => ({ history: [] as ScheduleHistoryEntry[] })),
        serversApi.getAll().catch(() => ({ servers: [] as ServerInstance[] })),
      ])
      setTasks(tasksData.tasks || [])
      setStatus(statusData)
      setHistory(historyData.history || [])
      setServers(serversData.servers || [])
    } catch (err) {
      reportClientError('Failed to fetch scheduler data.', err)
      setError(getUserErrorMessage(err, 'The backend may be unreachable.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  useEffect(() => {
    if (!timezone && status?.configuredTimezone) setTimezone(status.configuredTimezone)
  }, [status?.configuredTimezone, timezone])

  const serverName = (id: string | number | null) => {
    if (id == null) return null
    const match = servers.find((s) => String(s.id) === String(id))
    return match ? match.name || match.serverName : 'Unknown server'
  }

  const runNow = async (task: ScheduledTask) => {
    setRunningId(task.id)
    try {
      await schedulerApi.runTask(task.id)
      toastManager.add({ title: `"${task.name}" is running`, type: 'success' })
      void fetchData()
    } catch (err) {
      toastManager.add({ title: "The task didn't run", description: getUserErrorMessage(err, 'Try again.'), type: 'error' })
    } finally {
      setRunningId(null)
    }
  }

  const toggle = async (task: ScheduledTask) => {
    setBusy(true)
    try {
      await schedulerApi.updateTask(task.id, task.name, task.cron_expression, task.command, !task.enabled, task.server_id ?? undefined)
      void fetchData()
    } catch (err) {
      toastManager.add({ title: "Couldn't update the task", description: getUserErrorMessage(err, 'Try again.'), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (task: ScheduledTask) => {
    if (!(await confirm({ title: `Delete "${task.name}"?`, description: "The task stops running and can't be restored.", confirmLabel: 'Delete task' }))) return
    setBusy(true)
    try {
      await schedulerApi.deleteTask(task.id)
      toastManager.add({ title: 'Task deleted', type: 'success' })
      void fetchData()
    } catch (err) {
      toastManager.add({ title: "Couldn't delete the task", description: getUserErrorMessage(err, 'Try again.'), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const clearHistory = async () => {
    if (!(await confirm({ title: 'Clear all run history?', description: `This deletes every recorded run, not just the ${history.length} shown here.`, confirmLabel: 'Clear history' }))) return
    try {
      await schedulerApi.clearHistory()
      setHistory([])
    } catch (err) {
      toastManager.add({ title: "Couldn't clear the history", description: getUserErrorMessage(err, 'Try again.'), type: 'error' })
    }
  }

  const saveTimezone = async () => {
    setSavingTimezone(true)
    try {
      const result = await schedulerApi.setTimezone(timezone.trim())
      setStatus((prev) => (prev ? { ...prev, ...result } : prev))
      toastManager.add({ title: `Schedules now run in ${result.timezone}`, type: 'success' })
    } catch (err) {
      toastManager.add({ title: "Couldn't save the timezone", description: getUserErrorMessage(err, 'Try again.'), type: 'error' })
    } finally {
      setSavingTimezone(false)
    }
  }

  if (loading) return <PageLoading />

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Schedule"
        description="Everything that runs on its own: tasks, backups and restarts."
        actions={
          <Button onClick={() => setDialog({ open: true, task: null })}>
            <Plus />
            New task
          </Button>
        }
      />

      {error && (
        <Alert variant="error">
          <AlertTitle>The schedule couldn't be loaded</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void fetchData()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {status?.timezoneFallback && (
        <Alert variant="error">
          <AlertTitle>The saved timezone no longer works</AlertTitle>
          <AlertDescription>
            "{status.timezoneFallback.configured}" can't be used, perhaps because the panel was restored on another machine. Schedules run in {status.timezoneFallback.effective} until you
            pick a new one below.
          </AlertDescription>
        </Alert>
      )}

      <SettingsCard title="Tasks" description={tasks.length ? `${tasks.filter((t) => t.enabled).length} of ${tasks.length} on.` : undefined}>
        {tasks.length === 0 ? (
          <EmptyState compact type="noSchedule" title="No tasks yet" description="Run commands like restarts or saves on a schedule." action={{ label: 'New task', onClick: () => setDialog({ open: true, task: null }) }} />
        ) : (
          <ul className="divide-y">
            {tasks.map((task) => (
              <li key={task.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3">
                <div className={task.enabled && !task.unsupported ? 'grid min-w-0 gap-0.5' : 'grid min-w-0 gap-0.5 opacity-64'}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{task.name}</span>
                    {serverName(task.server_id) && <Badge variant="secondary">{serverName(task.server_id)}</Badge>}
                    {task.unsupported && <Badge variant="warning">Won't run</Badge>}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {describeCron(task.cron_expression)} · <code className="font-mono">{task.command}</code>
                  </span>
                  {task.unsupported && <span className="text-sm text-warning-foreground">This command isn't supported anymore. Edit it or delete the task.</span>}
                  {task.last_run && <span className="text-sm text-muted-foreground">Last ran {new Date(task.last_run).toLocaleString('en')}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={!!task.enabled} onCheckedChange={() => void toggle(task)} disabled={busy || (task.unsupported && !task.enabled)} aria-label={`Turn ${task.name} ${task.enabled ? 'off' : 'on'}`} />
                  <Menu>
                    <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${task.name}`} />}>
                      {runningId === task.id ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem onClick={() => void runNow(task)} disabled={runningId !== null || task.unsupported}>
                        <Play />
                        Run now
                      </MenuItem>
                      <MenuItem onClick={() => setDialog({ open: true, task })}>
                        <Pencil />
                        Edit
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem variant="destructive" onClick={() => void remove(task)}>
                        <Trash2 />
                        Delete
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <RestartNow running={runState === 'running'} />
      <AutomaticBackups />
      <ModUpdateRestarts />
      <RestartMessages status={status} onSaved={(restartWarning) => setStatus((prev) => (prev ? { ...prev, restartWarning } : prev))} />

      <SettingsCard title="Timezone" description="Tasks, automatic backups and restarts all run on this clock.">
        <SettingsRow label="IANA timezone" htmlFor="schedule-timezone" description={`In effect now: ${status?.timezone || '…'}`}>
          <div className="flex items-center gap-2">
            <TimezoneField id="schedule-timezone" value={timezone} onChange={setTimezone} disabled={savingTimezone} />
            <Button size="sm" variant="outline" onClick={() => void saveTimezone()} disabled={savingTimezone || !timezone.trim() || timezone.trim() === status?.configuredTimezone}>
              Save
            </Button>
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Run history"
        description={history.length >= HISTORY_LIMIT ? `The latest ${history.length} runs.` : undefined}
        action={
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => void fetchData()}>
              <RefreshCw />
              Refresh
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void clearHistory()} disabled={history.length === 0}>
              <Trash2 />
              Clear
            </Button>
          </div>
        }
      >
        {history.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Runs show up here.</p>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {history.map((entry) => (
              <li key={entry.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 py-3 text-sm">
                {entry.success ? <CheckCircle2 className="mt-0.5 size-4 text-success-foreground" aria-label="Succeeded" /> : <XCircle className="mt-0.5 size-4 text-destructive-foreground" aria-label="Failed" />}
                <div className="grid min-w-0 gap-0.5">
                  <span>
                    <span className="font-medium">{entry.task_name}</span> <code className="font-mono text-muted-foreground">{entry.command}</code>
                  </span>
                  {entry.message && <span className={entry.success ? 'text-muted-foreground' : 'text-destructive-foreground'}>{entry.message}</span>}
                </div>
                <span className="text-muted-foreground tabular-nums">
                  {new Date(entry.executed_at).toLocaleString('en')}
                  {entry.duration !== null && ` · ${(entry.duration / 1000).toFixed(1)}s`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <TaskDialog open={dialog.open} onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))} task={dialog.task} servers={servers} timezone={status?.timezone} onSaved={() => void fetchData()} />
    </div>
  )
}
