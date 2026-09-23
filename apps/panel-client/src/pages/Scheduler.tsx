import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  Clock,
  Plus,
  Trash2,
  RotateCcw,
  Calendar,
  History,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Play,
  Pencil,
  Loader2,
  AlertCircle,
  ChevronDown,
  HelpCircle,
  Search,
  SearchX,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import {
  schedulerApi,
  rconApi,
  serverApi,
  serversApi,
  ScheduleHistoryEntry,
  ServerInstance,
} from '@/lib/api'
import { EmptyState } from '@/components/EmptyState'
import { NumberInput } from '@/components/NumberInput'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { HelpTip } from '@/components/HelpTip'
import { cn } from '@/lib/utils'

const RESTART_WARNING_LOCALES = ['en', 'zh-CN', 'fr', 'de', 'es', 'ht'] as const

interface ScheduledTask {
  id: number
  name: string
  cron_expression: string
  command: string
  server_id: string | number | null
  enabled: number
  unsupported?: boolean
  last_run: string | null
  created_at: string
}

interface CronPreset {
  name: string
  cron: string
}

function getWeekDays() {
  return [
    { value: '1', short: 'MON', name: 'Monday' },
    { value: '2', short: 'TUE', name: 'Tuesday' },
    { value: '3', short: 'WED', name: 'Wednesday' },
    { value: '4', short: 'THU', name: 'Thursday' },
    { value: '5', short: 'FRI', name: 'Friday' },
    { value: '6', short: 'SAT', name: 'Saturday' },
    { value: '0', short: 'SUN', name: 'Sunday' },
  ]
}

function getCommonCommands() {
  return [
    { label: 'Restart Server', value: 'restart' },
    { label: 'Save World', value: 'save' },
    {
      label: 'Server Message',
      value: 'servermsg Server maintenance in progress',
    },
    { label: 'Check Mod Updates', value: 'checkModsNeedUpdate' },
    { label: 'Restore Utilities', value: 'bridge:restoreUtilities' },
    { label: 'Shut Off Utilities', value: 'bridge:shutOffUtilities' },
    { label: 'Save World (PanelBridge)', value: 'bridge:saveWorld' },
    {
      label: 'Broadcast (Server Chat)',
      value: 'bridge:sendToServerChat {"message":"Scheduled broadcast"}',
    },
  ]
}

const EXECUTION_HISTORY_FETCH_LIMIT = 50

type IntlWithSupportedValuesOf = typeof Intl & {
  supportedValuesOf?: (key: 'timeZone') => string[]
}

const TIMEZONE_POOL: string[] = (() => {
  let canonical: string[] = []
  try {
    const supportedValuesOf = (Intl as IntlWithSupportedValuesOf)
      .supportedValuesOf
    if (typeof supportedValuesOf === 'function') {
      canonical = supportedValuesOf('timeZone')
    }
  } catch {
    // Unsupported engine (pre-2022 Safari, etc.) -- degrade to just the
    // hand-picked entries below rather than crashing the whole page.
  }
  return Array.from(new Set(['UTC', ...canonical]))
})()

function timezoneGroup(zone: string): string {
  const slash = zone.indexOf('/')
  return slash === -1 ? zone : zone.slice(0, slash).replace(/_/g, ' ')
}

interface TimezonePickerProps {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

function TimezonePicker({
  id,
  value,
  onChange,
  disabled,
}: TimezonePickerProps) {
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dropUp, setDropUp] = useState(false)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      )
        setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    setHighlightIndex(-1)
  }, [value, open])

  useEffect(() => {
    if (!open || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setDropUp(window.innerHeight - rect.bottom < 320)
  }, [open])

  const query = searching ? value.trim().toLowerCase().replace(/_/g, ' ') : ''
  const { visible, grouped } = useMemo(() => {
    if (!query) {
      const groups = new Map<string, string[]>()
      for (const zone of TIMEZONE_POOL) {
        const g = timezoneGroup(zone)
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(zone)
      }
      for (const list of groups.values())
        list.sort((a, b) => a.localeCompare(b))
      const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) =>
        a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b),
      )
      return {
        visible: sortedGroups.flatMap(([, zones]) => zones),
        grouped: sortedGroups,
      }
    }
    const filtered = TIMEZONE_POOL.filter((z) =>
      z.toLowerCase().replace(/_/g, ' ').includes(query),
    ).sort((a, b) => a.localeCompare(b))
    return { visible: filtered, grouped: null as [string, string[]][] | null }
  }, [query])

  const handleSelect = (zone: string) => {
    onChange(zone)
    setOpen(false)
    setHighlightIndex(-1)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightIndex((prev) => Math.min(prev + 1, visible.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Enter':
        if (highlightIndex >= 0 && highlightIndex < visible.length) {
          e.preventDefault()
          handleSelect(visible[highlightIndex])
        }
        break
      case 'Escape':
        setOpen(false)
        setHighlightIndex(-1)
        break
    }
  }

  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return
    const el = listRef.current.querySelector(
      `[data-tz-index="${highlightIndex}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  const renderOption = (zone: string) => {
    const idx = visible.indexOf(zone)
    return (
      <button
        key={zone}
        type="button"
        role="option"
        id={`${id}-opt-${idx}`}
        aria-selected={zone === value}
        data-tz-index={idx}
        onClick={() => handleSelect(zone)}
        className={cn(
          'w-full px-3 py-1.5 text-start text-xs font-mono truncate motion-safe:transition-colors',
          'hover:bg-accent/10',
          zone === value && 'bg-primary/10 text-primary',
          idx === highlightIndex && 'bg-accent/15',
        )}
      >
        {zone}
      </button>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search
          className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50"
          aria-hidden="true"
        />
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          aria-activedescendant={
            open && highlightIndex >= 0 && visible[highlightIndex]
              ? `${id}-opt-${highlightIndex}`
              : undefined
          }
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
            setSearching(true)
          }}
          onFocus={(e) => {
            setOpen(true)
            setSearching(false)
            e.target.select()
          }}
          onKeyDown={handleKeyDown}
          placeholder="America/New_York"
          className="font-mono ps-8 pe-8"
          maxLength={100}
          disabled={disabled}
          autoComplete="off"
        />
        <ChevronDown
          className={cn(
            'pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60 motion-safe:transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </div>
      {open && !disabled && (
        <div
          className={cn(
            'absolute z-50 w-full min-w-[260px] rounded-md border border-border bg-popover shadow-lg',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          <div
            ref={listRef}
            role="listbox"
            id={`${id}-listbox`}
            aria-label={'IANA timezone name'}
            className="max-h-64 overflow-y-auto overscroll-contain py-1"
          >
            {visible.length === 0 ? (
              <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                <SearchX
                  className="w-3.5 h-3.5 shrink-0 opacity-50"
                  aria-hidden="true"
                />
                {'No matching timezone'}
              </p>
            ) : grouped ? (
              grouped.map(([group, zones]) => (
                <div key={group}>
                  {!(zones.length === 1 && zones[0] === group) && (
                    <div className="sticky top-0 z-10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 bg-muted/70 backdrop-blur-sm">
                      {group}
                    </div>
                  )}
                  {zones.map(renderOption)}
                </div>
              ))
            ) : (
              visible.map(renderOption)
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Scheduler() {
  const weekDays = useMemo(() => getWeekDays(), [])
  const commonCommands = useMemo(() => getCommonCommands(), [])
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [history, setHistory] = useState<ScheduleHistoryEntry[]>([])
  const [presets, setPresets] = useState<CronPreset[]>([])
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [status, setStatus] = useState<{
    activeTasks: number
    autoRestartEnabled: boolean
    modUpdateRestartPending: boolean
    timezone?: string
    configuredTimezone?: string | null
    timezoneFallback?: { configured: string; effective: string } | null
    restartWarning?: {
      locale: (typeof RESTART_WARNING_LOCALES)[number]
      template: string
    }
    restartWarningPresets?: Record<
      (typeof RESTART_WARNING_LOCALES)[number],
      string
    >
  } | null>(null)
  const [timezoneInput, setTimezoneInput] = useState('')
  const [timezoneSaving, setTimezoneSaving] = useState(false)
  const [restartWarningLocale, setRestartWarningLocale] =
    useState<(typeof RESTART_WARNING_LOCALES)[number]>('en')
  const [restartWarningTemplate, setRestartWarningTemplate] = useState('')
  const [restartWarningSaving, setRestartWarningSaving] = useState(false)
  const restartWarningDirtyRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [runningTaskId, setRunningTaskId] = useState<number | null>(null)
  const [broadcastingKey, setBroadcastingKey] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const { toast } = useToast()

  const [newTaskName, setNewTaskName] = useState('')
  const [newTaskCron, setNewTaskCron] = useState('')
  const [newTaskCommand, setNewTaskCommand] = useState('')
  const [newTaskServerId, setNewTaskServerId] = useState<string>('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null)

  const [cronValidation, setCronValidation] = useState<{
    valid: boolean
    error?: string
    code?: string
  } | null>(null)
  const cronValidationIdRef = useRef(0)

  const [scheduleMode, setScheduleMode] = useState<'simple' | 'advanced'>(
    'simple',
  )
  const [simpleIntervalType, setSimpleIntervalType] = useState<
    'hourly' | 'daily' | 'weekly' | 'interval'
  >('daily')
  const [simpleHour, setSimpleHour] = useState('06')
  const [simpleMinute, setSimpleMinute] = useState('00')
  const [simpleHoursInterval, setSimpleHoursInterval] = useState('4')
  const [simpleWeekday, setSimpleWeekday] = useState('1')

  const [restartMinutes, setRestartMinutes] = useState(5)
  const [serverRunning, setServerRunning] = useState<boolean>(false)

  const fetchData = useCallback(async () => {
    setFetchError(null)
    try {
      const [tasksData, presetsData, statusData, historyData, serversData] =
        await Promise.all([
          schedulerApi.getTasks(),
          schedulerApi
            .getCronPresets()
            .catch(() => ({ presets: [] as CronPreset[] })),
          schedulerApi.getStatus().catch(() => null),
          schedulerApi
            .getHistory(EXECUTION_HISTORY_FETCH_LIMIT)
            .catch(() => ({ history: [] as ScheduleHistoryEntry[] })),
          serversApi
            .getAll()
            .catch(() => ({ servers: [] as ServerInstance[] })),
        ])
      setTasks(tasksData.tasks || [])
      setPresets(presetsData.presets || [])
      setStatus(statusData)
      setHistory(historyData.history || [])
      const serverList: ServerInstance[] = serversData.servers || []
      setServers(serverList)
      setNewTaskServerId((prev) => {
        if (prev) return prev
        const active = serverList.find((s) => s.isActive)
        return active
          ? String(active.id)
          : serverList[0]
            ? String(serverList[0].id)
            : ''
      })
    } catch (error) {
      reportClientError('Failed to fetch scheduler data.', error)
      setFetchError(
        getUserErrorMessage(
          error,
          'Failed to load scheduler data. The backend may be unreachable.',
        ),
      )
    } finally {
      setInitialLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    if (timezoneInput === '' && status?.configuredTimezone) {
      setTimezoneInput(status.configuredTimezone)
    }
  }, [status?.configuredTimezone, timezoneInput])

  useEffect(() => {
    if (!restartWarningDirtyRef.current && status?.restartWarning) {
      setRestartWarningLocale(status.restartWarning.locale)
      setRestartWarningTemplate(status.restartWarning.template)
    }
  }, [status?.restartWarning])

  const handleSaveTimezone = async () => {
    const trimmed = timezoneInput.trim()
    if (!trimmed) return
    setTimezoneSaving(true)
    try {
      const result = await schedulerApi.setTimezone(trimmed)
      setStatus((prev) => (prev ? { ...prev, ...result } : prev))
      toast({
        title: 'Success',
        description: 'Schedules now run in ' + String(result.timezone) + '.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to save the timezone'),
        variant: 'destructive',
      })
    } finally {
      setTimezoneSaving(false)
    }
  }

  const selectRestartWarningLocale = (
    locale: (typeof RESTART_WARNING_LOCALES)[number],
  ) => {
    restartWarningDirtyRef.current = true
    setRestartWarningLocale(locale)
    setRestartWarningTemplate(status?.restartWarningPresets?.[locale] || '')
  }

  const resetRestartWarningTemplate = () => {
    restartWarningDirtyRef.current = true
    setRestartWarningTemplate(
      status?.restartWarningPresets?.[restartWarningLocale] || '',
    )
  }

  const handleSaveRestartWarning = async () => {
    if (!restartWarningTemplate.trim()) return
    setRestartWarningSaving(true)
    try {
      const result = await schedulerApi.setRestartWarning({
        locale: restartWarningLocale,
        template: restartWarningTemplate,
      })
      restartWarningDirtyRef.current = false
      setRestartWarningTemplate(result.restartWarning.template)
      setStatus((previous) =>
        previous
          ? { ...previous, restartWarning: result.restartWarning }
          : previous,
      )
      toast({
        title: 'Success',
        description: 'Restart warnings saved',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(
          error,
          'Failed to save restart warnings',
        ),
        variant: 'destructive',
      })
    } finally {
      setRestartWarningSaving(false)
    }
  }

  useEffect(() => {
    if (scheduleMode !== 'advanced' || !newTaskCron.trim()) {
      setCronValidation(null)
      return
    }
    const validationId = ++cronValidationIdRef.current
    const timer = setTimeout(() => {
      schedulerApi
        .validateCron(newTaskCron)
        .then((result) => {
          if (cronValidationIdRef.current !== validationId) return
          setCronValidation(result)
        })
        // Advisory only -- a failed preview call says nothing about whether
        // the expression is actually valid, so it clears any stale verdict
        // rather than showing a wrong one. Save still works either way: the
        // server validates independently at submit time.
        .catch(() => {
          if (cronValidationIdRef.current !== validationId) return
          setCronValidation(null)
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [newTaskCron, scheduleMode])

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        return
      try {
        const s = await serverApi.getStatus()
        if (!cancelled) setServerRunning(!!s?.running)
      } catch {
        if (!cancelled) setServerRunning(false)
      }
    }
    pull()
    const id = setInterval(pull, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const getServerLabel = (serverId: string | number | null): string | null => {
    if (!serverId) return null
    const match = servers.find((s) => String(s.id) === String(serverId))
    return match
      ? match.name || match.serverName || `Server ${serverId}`
      : 'Unknown server'
  }

  const buildSimpleCron = (): string => {
    const clamp = (raw: string, min: number, max: number, fallback: number) => {
      const parsed = parseInt(raw, 10)
      if (!Number.isFinite(parsed)) return fallback
      return Math.min(Math.max(parsed, min), max)
    }
    if (simpleIntervalType === 'daily') {
      return `${clamp(simpleMinute, 0, 59, 0)} ${clamp(simpleHour, 0, 23, 0)} * * *`
    }
    if (simpleIntervalType === 'weekly') {
      return `${clamp(simpleMinute, 0, 59, 0)} ${clamp(simpleHour, 0, 23, 0)} * * ${simpleWeekday}`
    }
    if (simpleIntervalType === 'hourly') return `0 * * * *`
    return `0 */${clamp(simpleHoursInterval, 1, 23, 1)} * * *`
  }

  const handleCreateTask = async () => {
    let cronToUse = newTaskCron

    if (scheduleMode === 'simple') {
      cronToUse = buildSimpleCron()
    }

    if (!newTaskName || !cronToUse || !newTaskCommand) {
      toast({
        title: 'Error',
        description: 'Please fill in all fields',
        variant: 'destructive',
      })
      return
    }

    try {
      const cronCheck = await schedulerApi.validateCron(cronToUse)
      if (!cronCheck.valid) {
        toast({
          title: 'Invalid Schedule',
          description:
            cronCheck.error || 'Invalid cron expression: ' + String(cronToUse),
          variant: 'destructive',
        })
        return
      }
    } catch {
      // Pre-check unreachable (network/500) -- fall through and let
      // create/update's own server-side validation be the final word,
      // same advisory-only philosophy as the live preview above.
    }

    setLoading(true)
    try {
      if (editingTask) {
        await schedulerApi.updateTask(
          editingTask.id,
          newTaskName,
          cronToUse,
          newTaskCommand,
          !!editingTask.enabled,
          newTaskServerId || undefined,
        )
      } else {
        await schedulerApi.createTask(
          newTaskName,
          cronToUse,
          newTaskCommand,
          newTaskServerId || undefined,
        )
      }
      toast({
        title: 'Success',
        description: editingTask
          ? 'Task updated successfully'
          : 'Task created successfully',
        variant: 'success' as const,
      })
      resetTaskForm()
      setDialogOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(
          error,
          editingTask ? 'Failed to update task' : 'Failed to create task',
        ),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const resetTaskForm = () => {
    setEditingTask(null)
    setNewTaskName('')
    setNewTaskCron('')
    setNewTaskCommand('')
    setNewTaskServerId(() => {
      const active = servers.find((s) => s.isActive)
      return active
        ? String(active.id)
        : servers[0]
          ? String(servers[0].id)
          : ''
    })
    setScheduleMode('simple')
    setSimpleIntervalType('daily')
    setSimpleHour('06')
    setSimpleMinute('00')
    setSimpleHoursInterval('4')
    setSimpleWeekday('1')
  }

  const applyCronToForm = (cronExpression: string) => {
    setNewTaskCron(cronExpression)
    const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cronExpression)
    if (daily) {
      setScheduleMode('simple')
      setSimpleIntervalType('daily')
      setSimpleMinute(daily[1])
      setSimpleHour(daily[2])
      return
    }
    const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(cronExpression)
    if (weekly) {
      setScheduleMode('simple')
      setSimpleIntervalType('weekly')
      setSimpleMinute(weekly[1])
      setSimpleHour(weekly[2])
      setSimpleWeekday(weekly[3])
      return
    }
    if (/^0 \* \* \* \*$/.test(cronExpression)) {
      setScheduleMode('simple')
      setSimpleIntervalType('hourly')
      return
    }
    const interval = /^0 \*\/(\d{1,2}) \* \* \*$/.exec(cronExpression)
    if (interval) {
      setScheduleMode('simple')
      setSimpleIntervalType('interval')
      setSimpleHoursInterval(interval[1])
      return
    }
    setScheduleMode('advanced')
  }

  const handleEditTask = (task: ScheduledTask) => {
    setEditingTask(task)
    setNewTaskName(task.name)
    setNewTaskCommand(task.command)
    setNewTaskServerId(task.server_id != null ? String(task.server_id) : '')
    applyCronToForm(task.cron_expression)
    setDialogOpen(true)
  }

  const handleToggleTask = async (task: ScheduledTask) => {
    setLoading(true)
    try {
      await schedulerApi.updateTask(
        task.id,
        task.name,
        task.cron_expression,
        task.command,
        !task.enabled,
        task.server_id != null ? task.server_id : undefined,
      )
      toast({
        title: 'Success',
        description: task.enabled ? 'Task disabled' : 'Task enabled',
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to update task'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteTask = async (taskId: number) => {
    setLoading(true)
    try {
      await schedulerApi.deleteTask(taskId)
      toast({
        title: 'Success',
        description: 'Task deleted',
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to delete task'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleRunNow = async (task: ScheduledTask) => {
    if (runningTaskId !== null) return
    setRunningTaskId(task.id)
    try {
      await schedulerApi.runTask(task.id)
      toast({
        title: 'Task Triggered',
        description: '"' + String(task.name) + '" is running',
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to run task'),
        variant: 'destructive',
      })
    } finally {
      setRunningTaskId(null)
    }
  }

  const handleRestartNow = async () => {
    setLoading(true)
    try {
      const result = await schedulerApi.restartNow(restartMinutes)
      const applied = result.warningMinutes
      if (applied !== restartMinutes) {
        toast({
          title: 'Restart Initiated',
          description:
            'You entered ' +
            String(restartMinutes) +
            ' minutes, but the warning countdown is capped at ' +
            String(applied) +
            '. Server will restart in ' +
            String(applied) +
            ' minutes instead.',
          variant: 'warning' as const,
        })
      } else {
        toast({
          title: 'Restart Initiated',
          description:
            Number(applied) === 1
              ? 'Server will restart in ' + String(applied) + ' minute'
              : 'Server will restart in ' + String(applied) + ' minutes',
          variant: 'success' as const,
        })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to initiate restart'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleRestartWithWarning = async (minutes: number) => {
    setLoading(true)
    try {
      const result = await schedulerApi.restartNow(minutes)
      toast({
        title: 'Restart Initiated',
        description:
          Number(result.warningMinutes) === 1
            ? 'Server will restart in ' +
              String(result.warningMinutes) +
              ' minute with countdown warnings'
            : 'Server will restart in ' +
              String(result.warningMinutes) +
              ' minutes with countdown warnings',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to initiate restart'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleBroadcast = async (key: string, message: string) => {
    setBroadcastingKey(key)
    try {
      await rconApi.execute(`servermsg "${message}"`)
      toast({
        title: 'Broadcast Sent',
        description: message,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to broadcast'),
        variant: 'destructive',
      })
    } finally {
      setBroadcastingKey(null)
    }
  }

  const handleClearHistory = async () => {
    setLoading(true)
    try {
      await schedulerApi.clearHistory()
      setHistory([])
      toast({
        title: 'Success',
        description: 'History cleared',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to clear history'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center min-h-[320px] py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4 page-transition">
      {fetchError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{'Scheduler data could not be loaded'}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 break-words" dir="auto">
              {fetchError}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchData}
              className="self-start"
            >
              <RefreshCw className="me-2 h-4 w-4" /> {'Retry'}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) resetTaskForm()
        }}
      >
        <PageHeader
          title={'Scheduler'}
          description={'Automate server tasks and restarts'}
          eyebrow={'Maintenance'}
          tone="maintain"
          icon={<Clock className="w-5 h-5" />}
          actions={
            <DialogTrigger asChild>
              <Button variant="command" onClick={resetTaskForm}>
                <Plus className="w-4 h-4 me-2" />
                {'New Task'}
              </Button>
            </DialogTrigger>
          }
        />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingTask ? 'Edit Scheduled Task' : 'Create Scheduled Task'}
            </DialogTitle>
            <DialogDescription>
              {editingTask
                ? 'Change the schedule, command, or target server for "' +
                  String(editingTask.name) +
                  '".'
                : 'Run a command on a schedule.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>{'Task Name'}</Label>
              <Input
                value={newTaskName}
                onChange={(e) => setNewTaskName(e.target.value)}
                placeholder={'e.g., Daily Restart'}
                maxLength={100}
              />
            </div>
            <div>
              <Label className="mb-2 block">{'Schedule Type'}</Label>
              <Tabs
                value={scheduleMode}
                onValueChange={(v: string) =>
                  setScheduleMode(v as 'simple' | 'advanced')
                }
                className="w-full"
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="simple">{'Simple Builder'}</TabsTrigger>
                  <TabsTrigger value="advanced">
                    {'Advanced (Cron)'}
                  </TabsTrigger>
                </TabsList>

                <TabsContent
                  value="simple"
                  className="space-y-4 pt-4 border rounded-md p-4 mt-0 border-t-0 rounded-t-none"
                >
                  <div className="space-y-2">
                    <Label>{'Frequency'}</Label>
                    <Select
                      value={simpleIntervalType}
                      onValueChange={(v) =>
                        setSimpleIntervalType(
                          v as 'hourly' | 'daily' | 'weekly' | 'interval',
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="hourly">
                          {'Every Hour (at minute 0)'}
                        </SelectItem>
                        <SelectItem value="interval">
                          {'Every X Hours'}
                        </SelectItem>
                        <SelectItem value="daily">
                          {'Daily at Specific Time'}
                        </SelectItem>
                        <SelectItem value="weekly">
                          {'Weekly on a Specific Day'}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {status?.timezone && (
                    <p className="text-xs text-muted-foreground">
                      {"Times below run in the panel's timezone: " +
                        String(status.timezone)}
                    </p>
                  )}

                  {simpleIntervalType === 'weekly' && (
                    <div className="space-y-2">
                      <Label>{'Day of the week'}</Label>
                      <div
                        className="grid grid-cols-4 gap-2 sm:grid-cols-7"
                        role="group"
                        aria-label={'Day of the week'}
                      >
                        {weekDays.map((day) => {
                          const selected = simpleWeekday === day.value
                          return (
                            <Button
                              key={day.value}
                              type="button"
                              variant={selected ? 'default' : 'outline'}
                              size="sm"
                              className="h-10 px-2 text-[11px] tracking-[0.12em]"
                              aria-pressed={selected}
                              aria-label={day.name}
                              onClick={() => setSimpleWeekday(day.value)}
                            >
                              {day.short}
                            </Button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {(simpleIntervalType === 'daily' ||
                    simpleIntervalType === 'weekly') && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>{'Hour (0-23)'}</Label>
                        <Input
                          type="number"
                          min={0}
                          max={23}
                          value={simpleHour}
                          onChange={(e) => setSimpleHour(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{'Minute (0-59)'}</Label>
                        <Input
                          type="number"
                          min={0}
                          max={59}
                          value={simpleMinute}
                          onChange={(e) => setSimpleMinute(e.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  {simpleIntervalType === 'interval' && (
                    <div className="space-y-2">
                      <Label>{'Every X Hours'}</Label>
                      <Input
                        type="number"
                        min={1}
                        max={23}
                        value={simpleHoursInterval}
                        onChange={(e) => setSimpleHoursInterval(e.target.value)}
                        placeholder={'e.g. 4 for every 4 hours'}
                      />
                    </div>
                  )}

                  <div className="bg-muted p-3 rounded text-xs flex items-center justify-between">
                    <span className="text-muted-foreground">
                      {'Generated Cron:'}
                    </span>
                    <code className="font-mono bg-background px-2 py-1 rounded border">
                      {buildSimpleCron()}
                    </code>
                  </div>
                </TabsContent>

                <TabsContent
                  value="advanced"
                  className="space-y-3 pt-4 border rounded-md p-4 mt-0 border-t-0 rounded-t-none"
                >
                  <div className="space-y-2">
                    <Label>{'Load Preset'}</Label>
                    <Select onValueChange={(value) => setNewTaskCron(value)}>
                      <SelectTrigger>
                        <SelectValue placeholder={'Select a preset...'} />
                      </SelectTrigger>
                      <SelectContent>
                        {presets.map((preset) => (
                          <SelectItem key={preset.cron} value={preset.cron}>
                            {String(preset.name) +
                              ' (' +
                              String(preset.cron) +
                              ')'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>{'Custom Expression'}</Label>
                    <Input
                      value={newTaskCron}
                      onChange={(e) => setNewTaskCron(e.target.value)}
                      placeholder={'e.g., 0 */2 * * *'}
                      className="font-mono"
                      maxLength={100}
                      aria-label={'Cron expression'}
                      aria-describedby="cron-format-hint"
                    />
                  </div>
                  <p
                    id="cron-format-hint"
                    className="text-xs text-muted-foreground"
                  >
                    {'Format: minute hour day month weekday'}
                  </p>
                  {cronValidation && (
                    <p
                      className={`flex items-center gap-1.5 text-xs ${cronValidation.valid ? 'text-primary' : 'text-destructive'}`}
                      aria-live="polite"
                    >
                      {cronValidation.valid ? (
                        <CheckCircle2
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                      ) : (
                        <AlertCircle
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      {cronValidation.valid
                        ? 'Valid expression'
                        : cronValidation.error}
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <Label>{'Command'}</Label>
                <HelpTip label={'Command'}>
                  {
                    "This runs unattended on the schedule above, with no confirmation each time it fires. Pick something safe to repeat automatically -- a custom command isn't checked against a safe list, and it keeps running until you disable or delete this task."
                  }
                </HelpTip>
              </div>
              <Select onValueChange={(value) => setNewTaskCommand(value)}>
                <SelectTrigger>
                  <SelectValue placeholder={'Select common command...'} />
                </SelectTrigger>
                <SelectContent>
                  {commonCommands.map((cmd) => (
                    <SelectItem key={cmd.value} value={cmd.value}>
                      {cmd.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="mt-2"
                value={newTaskCommand}
                onChange={(e) => setNewTaskCommand(e.target.value)}
                placeholder={'Or enter custom command'}
                maxLength={2000}
              />
              {newTaskCommand.startsWith('bridge:') && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  <>
                    {'Format: '}
                    <code className="text-foreground">
                      {'bridge:\u003caction> {json args}'}
                    </code>
                    {' — e.g. '}
                    <code className="ms-1 text-foreground">
                      {'bridge:saveWorld'}
                    </code>
                    {
                      '. Args are optional. Only allow-listed actions run via the scheduler.'
                    }
                  </>
                </p>
              )}
            </div>
            <div>
              <Label>{'Target Server'}</Label>
              <Select
                value={newTaskServerId}
                onValueChange={setNewTaskServerId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={'Select a server...'} />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((server) => (
                    <SelectItem key={server.id} value={String(server.id)}>
                      {server.name || server.serverName}
                      {server.isActive ? ' (Active)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {
                  'This task always runs against this server, even if a different one is active when it fires.'
                }
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleCreateTask}
              disabled={loading}
              className="gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {editingTask ? 'Save Changes' : 'Create Task'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="p-4 pb-3">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">{'Scheduler Timezone'}</CardTitle>
            <HelpTip label={'Scheduler Timezone'}>
              {
                'Every schedule below -- your tasks, the automatic backup, and auto-restart -- runs in this timezone.'
              }
            </HelpTip>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-0 space-y-2">
          {status?.timezoneFallback && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{'Saved timezone is no longer valid'}</AlertTitle>
              <AlertDescription>
                {'"' +
                  String(status.timezoneFallback.configured) +
                  '" could not be used (it may have been removed from the timezone database, or this panel was restored from a different machine). Schedules are running in ' +
                  String(status.timezoneFallback.effective) +
                  ' until this is fixed.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="scheduler-timezone-input">
                {'IANA timezone name'}
              </Label>
              <TimezonePicker
                id="scheduler-timezone-input"
                value={timezoneInput}
                onChange={setTimezoneInput}
                disabled={timezoneSaving}
              />
            </div>
            <Button
              onClick={handleSaveTimezone}
              disabled={
                timezoneSaving ||
                !timezoneInput.trim() ||
                timezoneInput.trim() === status?.configuredTimezone
              }
            >
              {timezoneSaving ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : null}
              {'Save'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {'Currently in effect: ' + String(status?.timezone || '...')}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-3">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">{'Restart Warnings'}</CardTitle>
            <HelpTip label={'Restart Warnings'}>
              {
                'Automatic restart countdown messages sent to every connected player.'
              }
            </HelpTip>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="restart-warning-language">
                {'Message language'}
              </Label>
              <Select
                value={restartWarningLocale}
                onValueChange={(
                  locale: (typeof RESTART_WARNING_LOCALES)[number],
                ) => selectRestartWarningLocale(locale)}
                disabled={restartWarningSaving}
              >
                <SelectTrigger id="restart-warning-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESTART_WARNING_LOCALES.map((locale) => (
                    <SelectItem key={locale} value={locale}>
                      {(
                        {
                          en: 'English',
                          'zh-CN': 'Chinese (Simplified)',
                          fr: 'French',
                          de: 'German',
                          es: 'Spanish',
                          ht: 'Haitian Creole',
                        } as Record<string, string>
                      )[String(locale)] ?? String(locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="restart-warning-template">
                {'Countdown template'}
              </Label>
              <Textarea
                id="restart-warning-template"
                value={restartWarningTemplate}
                onChange={(event) => {
                  restartWarningDirtyRef.current = true
                  setRestartWarningTemplate(event.target.value)
                }}
                maxLength={300}
                disabled={restartWarningSaving}
              />
              <p className="text-xs text-muted-foreground">
                {
                  'Use {count} for the number and {unit} for minutes or seconds.'
                }
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={resetRestartWarningTemplate}
              disabled={
                restartWarningSaving ||
                !status?.restartWarningPresets?.[restartWarningLocale]
              }
            >
              {'Use language preset'}
            </Button>
            <Button
              onClick={handleSaveRestartWarning}
              disabled={restartWarningSaving || !restartWarningTemplate.trim()}
            >
              {restartWarningSaving ? (
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
              ) : null}
              {'Save warnings'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {tasks.length > 0 &&
        (() => {
          const activeCount = tasks.filter((t) => t.enabled).length
          const totalCount = tasks.length
          const restartCount = tasks.filter(
            (t) => t.command.toLowerCase() === 'restart',
          ).length
          const restartActive =
            tasks.filter(
              (t) => t.enabled && t.command.toLowerCase() === 'restart',
            ).length > 0
          const modRestartPending = !!status?.modUpdateRestartPending
          const tiles = [
            {
              icon: <Clock className="w-4 h-4" />,
              label: 'Active Tasks',
              value: String(activeCount),
              sub:
                Number(totalCount) === 1
                  ? String(totalCount) + ' total task'
                  : String(totalCount) + ' total tasks',
              tone: activeCount > 0 ? 'primary' : 'muted',
            },
            {
              icon: <RotateCcw className="w-4 h-4" />,
              label: 'Restart Tasks',
              value: restartActive ? 'Scheduled' : 'None',
              sub:
                Number(restartCount) === 1
                  ? String(restartCount) + ' restart task'
                  : String(restartCount) + ' restart tasks',
              tone: restartActive ? 'primary' : 'muted',
            },
            {
              icon: <Calendar className="w-4 h-4" />,
              label: 'Mod Update Restart',
              value: modRestartPending ? 'Pending' : 'None',
              sub: 'Auto-restart on mod updates',
              tone: modRestartPending ? 'warning' : 'muted',
            },
          ] as const
          const toneClasses = {
            primary: {
              tile: 'border-primary/30 bg-primary/[0.06] text-primary',
              value: 'text-foreground',
            },
            warning: {
              tile: 'border-warning/40 bg-warning/10 text-warning',
              value: 'text-warning',
            },
            muted: {
              tile: 'border-border/55 bg-muted/30 text-muted-foreground',
              value: 'text-muted-foreground',
            },
          }
          return (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {tiles.map((tile) => {
                const cls = toneClasses[tile.tone]
                return (
                  <Card key={tile.label} className="overflow-hidden">
                    <CardContent className="flex items-center gap-3 p-4">
                      <div
                        className={`grid place-items-center w-10 h-10 rounded-md border ${cls.tile}`}
                        aria-hidden="true"
                      >
                        {tile.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {tile.label}
                        </p>
                        <p
                          className={`text-xl font-semibold leading-tight mt-0.5 ${cls.value}`}
                        >
                          {tile.value}
                        </p>
                        <p className="text-[11px] text-muted-foreground/80 mt-0.5 truncate">
                          {tile.sub}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )
        })()}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="p-4 pb-3">
            <CardTitle>{'Manual Restart'}</CardTitle>
            <CardDescription>
              {serverRunning
                ? 'Pick a countdown — players are warned and the server restarts when it ends.'
                : 'Server is offline — start it before issuing a restart.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => handleRestartWithWarning(15)}
                disabled={loading || !serverRunning}
                variant="outline"
                size="sm"
                // eslint-disable-next-line local/no-dead-disabled-title -- This title describes the action, not why it is disabled.
                title={'Restart in 15 minutes with countdown warnings'}
              >
                <Clock className="w-4 h-4 me-2" />
                {'Restart in 15m'}
              </Button>

              <Button
                onClick={() => handleRestartWithWarning(10)}
                disabled={loading || !serverRunning}
                variant="outline"
                size="sm"
                // eslint-disable-next-line local/no-dead-disabled-title -- This title describes the action, not why it is disabled.
                title={'Restart in 10 minutes with countdown warnings'}
              >
                <Clock className="w-4 h-4 me-2" />
                {'Restart in 10m'}
              </Button>

              <Button
                onClick={() => handleRestartWithWarning(5)}
                disabled={loading || !serverRunning}
                variant="outline"
                size="sm"
                // eslint-disable-next-line local/no-dead-disabled-title -- This title describes the action, not why it is disabled.
                title={'Restart in 5 minutes with countdown warnings'}
              >
                <Clock className="w-4 h-4 me-2" />
                {'Restart in 5m'}
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    disabled={loading || !serverRunning}
                    variant="warning"
                    size="sm"
                    // eslint-disable-next-line local/no-dead-disabled-title -- This title describes the action, not why it is disabled.
                    title={
                      'Restart in 1 minute — short warning, requires confirmation'
                    }
                  >
                    <Clock className="w-4 h-4 me-2" />
                    {'Restart in 1m'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {'Restart server in 1 minute?'}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {
                        'Players get a single 1-minute warning before the server goes down. Use longer countdowns if anyone is mid-fight or driving.'
                      }
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => handleRestartWithWarning(1)}
                      className="bg-warning text-warning-foreground hover:bg-warning/90"
                    >
                      {'Restart in 1m'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>

            <div className="flex items-end gap-4">
              <div className="flex-1 max-w-xs">
                <Label>{'Custom countdown (minutes)'}</Label>
                <NumberInput
                  value={restartMinutes}
                  onChange={setRestartMinutes}
                  min={1}
                  max={30}
                />
              </div>
              {restartMinutes < 5 ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      disabled={
                        loading ||
                        !serverRunning ||
                        !Number.isFinite(restartMinutes)
                      }
                      variant="warning"
                    >
                      <RotateCcw className="w-4 h-4 me-2" />
                      {'Restart Now'}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {Number(restartMinutes) === 1
                          ? 'Restart in ' + String(restartMinutes) + ' minute?'
                          : 'Restart in ' +
                            String(restartMinutes) +
                            ' minutes?'}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {
                          'Short countdowns can catch players mid-action. Confirm if you really want to restart this fast.'
                        }
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleRestartNow}
                        className="bg-warning text-warning-foreground hover:bg-warning/90"
                      >
                        {'Restart in ' + String(restartMinutes) + 'm'}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <Button
                  onClick={handleRestartNow}
                  disabled={
                    loading ||
                    !serverRunning ||
                    !Number.isFinite(restartMinutes)
                  }
                  variant="warning"
                >
                  <RotateCcw className="w-4 h-4 me-2" />
                  {'Restart Now'}
                </Button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {
                'Players see countdown warnings at 15m, 10m, 5m, and 1m as the timer ticks down.'
              }
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-3">
            <CardTitle>{'Quick Broadcasts'}</CardTitle>
            <CardDescription>
              {serverRunning
                ? 'Send common announcements to all players.'
                : 'Server is offline — broadcasts require a running server.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  handleBroadcast(
                    'maintenanceStart',
                    'Server entering MAINTENANCE MODE - Please save and disconnect',
                  )
                }
                variant="outline"
                size="sm"
                disabled={broadcastingKey !== null || loading || !serverRunning}
                className="gap-2"
              >
                {broadcastingKey === 'maintenanceStart' && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                {'Maintenance Start'}
              </Button>
              <Button
                onClick={() =>
                  handleBroadcast(
                    'maintenanceEnd',
                    'Maintenance complete - Server is back online!',
                  )
                }
                variant="outline"
                size="sm"
                disabled={broadcastingKey !== null || loading || !serverRunning}
                className="gap-2"
              >
                {broadcastingKey === 'maintenanceEnd' && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                {'Maintenance End'}
              </Button>
              <Button
                onClick={() =>
                  handleBroadcast(
                    'saveWarning',
                    'Server will save in 30 seconds - Brief lag expected',
                  )
                }
                variant="outline"
                size="sm"
                disabled={broadcastingKey !== null || loading || !serverRunning}
                className="gap-2"
              >
                {broadcastingKey === 'saveWarning' && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                {'Save Warning'}
              </Button>
              <Button
                onClick={() =>
                  handleBroadcast(
                    'welcome',
                    'Welcome! Please read the rules at spawn',
                  )
                }
                variant="outline"
                size="sm"
                disabled={broadcastingKey !== null || loading || !serverRunning}
                className="gap-2"
              >
                {broadcastingKey === 'welcome' && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                {'Welcome'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle>{'Scheduled Tasks'}</CardTitle>
          <CardDescription>{'Manage automated commands.'}</CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <ScrollArea className="h-[300px] sm:h-[400px]">
            {tasks.length === 0 ? (
              <EmptyState
                type="noSchedule"
                title={'No scheduled tasks'}
                description={'Create a task to run commands automatically.'}
              />
            ) : (
              <div className="space-y-3">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`group relative flex flex-col gap-3 p-4 rounded-lg border transition-colors sm:flex-row sm:items-center ${
                      task.enabled && !task.unsupported
                        ? 'bg-card border-border/60 hover:border-primary/40'
                        : 'bg-muted/30 border-border/40 text-muted-foreground'
                    }`}
                  >
                    <div className="flex flex-1 min-w-0 items-center gap-3">
                      <div
                        className="shrink-0 self-stretch flex items-center"
                        aria-hidden="true"
                      >
                        {task.enabled && !task.unsupported ? (
                          <span className="relative inline-flex">
                            <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping motion-reduce:hidden" />
                            <span className="relative w-2 h-2 rounded-full bg-primary" />
                          </span>
                        ) : (
                          <span className="w-2 h-2 rounded-full border border-muted-foreground/50" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="font-medium truncate text-foreground">
                            {task.name}
                          </h3>
                          {task.unsupported && (
                            <span className="text-xs text-warning">Unsupported command</span>
                          )}
                          {getServerLabel(task.server_id) && (
                            <span
                              className="shrink-0 text-[11px] font-medium bg-primary/10 border border-primary/30 px-1.5 py-0.5 rounded text-primary truncate max-w-[140px]"
                              title={
                                'Target server: ' +
                                String(getServerLabel(task.server_id))
                              }
                            >
                              {getServerLabel(task.server_id)}
                            </span>
                          )}
                          <code
                            className="shrink-0 text-[11px] font-mono bg-muted/70 border border-border/50 px-1.5 py-0.5 rounded text-muted-foreground truncate max-w-[180px]"
                            title={task.cron_expression}
                          >
                            {task.cron_expression}
                          </code>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1 truncate">
                          <code className="text-primary/90 font-mono text-xs">
                            {task.command}
                          </code>
                        </p>
                        {task.unsupported && (
                          <p className="text-xs text-warning mt-1">
                            {'This saved task will not run. Edit its command or delete it.'}
                          </p>
                        )}
                        {task.last_run && (
                          <p className="text-[11px] text-muted-foreground/70 mt-1">
                            {'Last run · ' +
                              String(
                                new Date(task.last_run).toLocaleString('en'),
                              )}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 self-end sm:self-auto">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRunNow(task)}
                        disabled={loading || runningTaskId !== null || task.unsupported}
                        // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Run task now"); disables only on transient UI state (a page-wide loading flag, or another task already running), not a permission gate -- no DisabledReason-worthy reason to lose. Triaged 2026-08-27.
                        title={'Run task now'}
                        aria-label={'Run ' + String(task.name) + ' now'}
                      >
                        {runningTaskId === task.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditTask(task)}
                        disabled={loading}
                        // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("Edit task"); disables only on the page-wide loading flag, not a permission gate -- no DisabledReason-worthy reason to lose. Triaged 2026-08-27.
                        title={'Edit task'}
                        aria-label={'Edit ' + String(task.name)}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Switch
                        checked={!!task.enabled}
                        onCheckedChange={() => handleToggleTask(task)}
                        disabled={loading || (task.unsupported && !task.enabled)}
                        aria-label={'Toggle ' + String(task.name)}
                      />
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={loading}
                            aria-label={'Delete task ' + String(task.name)}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {'Delete Scheduled Task'}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {'Are you sure you want to delete "' +
                                String(task.name) +
                                '"? This action cannot be undone.'}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDeleteTask(task.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              {'Delete'}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="w-5 h-5" />
                {'Execution History'}
              </CardTitle>
              <CardDescription>
                {'Recent task execution log.'}
                {history.length >= EXECUTION_HISTORY_FETCH_LIMIT && (
                  <span className="block text-xs text-muted-foreground/80">
                    {'Showing the most recent ' +
                      String(history.length) +
                      ' runs -- older executions may not be shown.'}
                  </span>
                )}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={fetchData}
                disabled={loading}
              >
                <RefreshCw className="w-4 h-4 me-1" />
                {'Refresh'}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading || history.length === 0}
                  >
                    <Trash2 className="w-4 h-4 me-1" />
                    {'Clear'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {'Clear Execution History'}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {Number(history.length) === 1
                        ? 'Are you sure you want to clear ALL execution history? This removes every recorded run, not just the ' +
                          String(history.length) +
                          ' shown here. This action cannot be undone.'
                        : 'Are you sure you want to clear ALL execution history? This removes every recorded run, not just the ' +
                          String(history.length) +
                          ' shown here. This action cannot be undone.'}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleClearHistory}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {'Clear All'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <ScrollArea className="h-[300px] sm:h-[400px]">
            {history.length === 0 ? (
              <EmptyState
                type="noSchedule"
                title={'No execution history'}
                description={'Executions will appear here.'}
              />
            ) : (
              <div className="space-y-2">
                {history.map((entry) => (
                  <div
                    key={entry.id}
                    className={`p-3 rounded-lg border border-border/40 ${
                      entry.success ? 'bg-card' : 'bg-destructive/[0.06]'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {entry.success ? (
                          <CheckCircle2
                            className="w-4 h-4 text-primary flex-shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <XCircle
                            className="w-4 h-4 text-destructive flex-shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span className="sr-only">
                          {entry.success ? 'Succeeded' : 'Failed'}
                        </span>
                        <div>
                          <span className="font-medium">{entry.task_name}</span>
                          <code className="ms-2 text-xs bg-muted px-1.5 py-0.5 rounded">
                            {entry.command}
                          </code>
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(entry.executed_at).toLocaleString('en')}
                      </span>
                    </div>
                    <div className="mt-1 ms-6 text-sm">
                      {entry.message && (
                        <p
                          className={
                            entry.success
                              ? 'text-muted-foreground'
                              : 'text-destructive'
                          }
                        >
                          {entry.message}
                        </p>
                      )}
                      {entry.duration !== null && (
                        <p className="text-xs text-muted-foreground">
                          {'Duration: ' +
                            String((entry.duration / 1000).toFixed(1)) +
                            's'}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      <Collapsible>
        <div className="rounded-xl border border-border/40 bg-card/40">
          <CollapsibleTrigger className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            <span className="flex items-center gap-2">
              <HelpCircle className="w-4 h-4" />
              {'Cron Expression Help'}
            </span>
            <ChevronDown className="w-4 h-4 transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-5 pb-4 pt-0">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
                <div>
                  <p className="font-medium">{'Minute'}</p>
                  <p className="text-muted-foreground">{'0-59'}</p>
                </div>
                <div>
                  <p className="font-medium">{'Hour'}</p>
                  <p className="text-muted-foreground">{'0-23'}</p>
                </div>
                <div>
                  <p className="font-medium">{'Day'}</p>
                  <p className="text-muted-foreground">{'1-31'}</p>
                </div>
                <div>
                  <p className="font-medium">{'Month'}</p>
                  <p className="text-muted-foreground">{'1-12'}</p>
                </div>
                <div>
                  <p className="font-medium">{'Weekday'}</p>
                  <p className="text-muted-foreground">{'0-6 (Sun-Sat)'}</p>
                </div>
              </div>
              <div className="mt-4 space-y-2 text-sm">
                <p>
                  <>
                    <code className="bg-muted px-1 rounded">{'*'}</code>
                    {' = any value'}
                  </>
                </p>
                <p>
                  <>
                    <code className="bg-muted px-1 rounded">{'*/n'}</code>
                    {' = every n units'}
                  </>
                </p>
                <p>
                  <>
                    <code className="bg-muted px-1 rounded">
                      {'0 */2 * * *'}
                    </code>
                    {' = every 2 hours'}
                  </>
                </p>
                <p>
                  <>
                    <code className="bg-muted px-1 rounded">{'0 6 * * *'}</code>
                    {' = daily at 6 AM'}
                  </>
                </p>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}
