import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { schedulerApi, type ServerInstance } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toastManager } from '@/components/ui/toast'

export interface ScheduledTask {
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

type Frequency = 'hourly' | 'interval' | 'daily' | 'weekly'

const FREQUENCIES = [
  { value: 'hourly', label: 'Every hour' },
  { value: 'interval', label: 'Every few hours' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
]

const WEEKDAYS = [
  { value: '1', label: 'Mon', name: 'Monday' },
  { value: '2', label: 'Tue', name: 'Tuesday' },
  { value: '3', label: 'Wed', name: 'Wednesday' },
  { value: '4', label: 'Thu', name: 'Thursday' },
  { value: '5', label: 'Fri', name: 'Friday' },
  { value: '6', label: 'Sat', name: 'Saturday' },
  { value: '0', label: 'Sun', name: 'Sunday' },
]

const COMMANDS = [
  { value: 'restart', label: 'Restart the server' },
  { value: 'save', label: 'Save the world' },
  { value: 'servermsg Server maintenance in progress', label: 'Send a server message' },
  { value: 'checkModsNeedUpdate', label: 'Check for mod updates' },
]

const clamp = (raw: string, min: number, max: number) => {
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : min
}

interface SimpleSchedule {
  frequency: Frequency
  hour: string
  minute: string
  everyHours: string
  weekday: string
}

const DEFAULT_SIMPLE: SimpleSchedule = { frequency: 'daily', hour: '06', minute: '00', everyHours: '4', weekday: '1' }

function toCron(s: SimpleSchedule): string {
  if (s.frequency === 'hourly') return '0 * * * *'
  if (s.frequency === 'interval') return `0 */${clamp(s.everyHours, 1, 23)} * * *`
  const time = `${clamp(s.minute, 0, 59)} ${clamp(s.hour, 0, 23)}`
  return s.frequency === 'daily' ? `${time} * * *` : `${time} * * ${s.weekday}`
}

/** Reads a cron expression back into the simple builder, or null if it needs the advanced editor. */
function fromCron(cron: string): SimpleSchedule | null {
  let m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron)
  if (m) return { ...DEFAULT_SIMPLE, frequency: 'daily', minute: m[1], hour: m[2] }
  m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(cron)
  if (m) return { ...DEFAULT_SIMPLE, frequency: 'weekly', minute: m[1], hour: m[2], weekday: m[3] }
  if (cron === '0 * * * *') return { ...DEFAULT_SIMPLE, frequency: 'hourly' }
  m = /^0 \*\/(\d{1,2}) \* \* \*$/.exec(cron)
  if (m) return { ...DEFAULT_SIMPLE, frequency: 'interval', everyHours: m[1] }
  return null
}

/** Human description of a cron expression the builder understands; the raw expression otherwise. */
export function describeCron(cron: string): string {
  const s = fromCron(cron)
  if (!s) return cron
  const time = `${String(clamp(s.hour, 0, 23)).padStart(2, '0')}:${String(clamp(s.minute, 0, 59)).padStart(2, '0')}`
  if (s.frequency === 'hourly') return 'Every hour'
  if (s.frequency === 'interval') return `Every ${clamp(s.everyHours, 1, 23)} hours`
  if (s.frequency === 'daily') return `Daily at ${time}`
  return `${WEEKDAYS.find((d) => d.value === s.weekday)?.name}s at ${time}`
}

export function TaskDialog({
  open,
  onOpenChange,
  task,
  servers,
  timezone,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: ScheduledTask | null
  servers: ServerInstance[]
  timezone?: string
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [serverId, setServerId] = useState('')
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple')
  const [simple, setSimple] = useState<SimpleSchedule>(DEFAULT_SIMPLE)
  const [cron, setCron] = useState('')
  const [presets, setPresets] = useState<Array<{ name: string; cron: string }>>([])
  const [validation, setValidation] = useState<{ valid: boolean; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const validationId = useRef(0)

  useEffect(() => {
    if (!open) return
    const parsed = task ? fromCron(task.cron_expression) : DEFAULT_SIMPLE
    setName(task?.name ?? '')
    setCommand(task?.command ?? '')
    const selected = servers.find((s) => s.isActive) ?? servers[0]
    setServerId(task?.server_id != null ? String(task.server_id) : selected ? String(selected.id) : '')
    setMode(parsed ? 'simple' : 'advanced')
    setSimple(parsed ?? DEFAULT_SIMPLE)
    setCron(task?.cron_expression ?? '')
    schedulerApi
      .getCronPresets()
      .then((data) => setPresets(data.presets || []))
      .catch(() => setPresets([]))
  }, [open, task, servers])

  // Advisory live check; the server validates again when saving.
  useEffect(() => {
    if (mode !== 'advanced' || !cron.trim()) {
      setValidation(null)
      return
    }
    const id = ++validationId.current
    const timer = setTimeout(() => {
      schedulerApi
        .validateCron(cron)
        .then((result) => validationId.current === id && setValidation(result))
        .catch(() => validationId.current === id && setValidation(null))
    }, 400)
    return () => clearTimeout(timer)
  }, [cron, mode])

  const expression = mode === 'simple' ? toCron(simple) : cron

  const save = async () => {
    const trimmed = command.trim()
    if (!name.trim() || !expression || !trimmed) {
      toastManager.add({ title: 'Fill in the name, schedule and command', type: 'error' })
      return
    }
    // "bridge:" commands were removed; only keep one that already exists unchanged.
    if (trimmed.toLowerCase().startsWith('bridge:') && trimmed !== task?.command.trim()) {
      toastManager.add({ title: 'Unsupported command', description: 'Choose a listed command or another RCON command.', type: 'error' })
      return
    }
    try {
      const check = await schedulerApi.validateCron(expression)
      if (!check.valid) {
        toastManager.add({ title: 'Check the schedule', description: check.error || `Not a valid cron expression: ${expression}`, type: 'error' })
        return
      }
    } catch {
      // The pre-check is advisory; the save request validates on the server.
    }
    setSaving(true)
    try {
      if (task) await schedulerApi.updateTask(task.id, name, expression, command, !!task.enabled, serverId || undefined)
      else await schedulerApi.createTask(name, expression, command, serverId || undefined)
      toastManager.add({ title: task ? 'Task saved' : 'Task created', type: 'success' })
      onOpenChange(false)
      onSaved()
    } catch (error) {
      toastManager.add({ title: task ? "Couldn't save the task" : "Couldn't create the task", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const serverItems = servers.map((s) => ({ value: String(s.id), label: s.name || s.serverName }))
  const presetItems = presets.map((p) => ({ value: p.cron, label: `${p.name} (${p.cron})` }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{task ? 'Edit task' : 'New task'}</DialogTitle>
          <DialogDescription>Runs a command on a schedule, with no confirmation each time. Pick something that's safe to repeat.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-5">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily restart" maxLength={100} />
          </label>

          <div className="grid gap-2 text-sm">
            <span className="font-medium">When</span>
            <Tabs value={mode} onValueChange={(value) => setMode(value as 'simple' | 'advanced')}>
              <TabsList>
                <TabsTab value="simple">Simple</TabsTab>
                <TabsTab value="advanced">Cron expression</TabsTab>
              </TabsList>
              <TabsPanel value="simple" className="grid gap-3 pt-3">
                <Select items={FREQUENCIES} value={simple.frequency} onValueChange={(value) => setSimple({ ...simple, frequency: value as Frequency })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {FREQUENCIES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {simple.frequency === 'weekly' && (
                  <ToggleGroup value={[simple.weekday]} onValueChange={(value) => value[0] && setSimple({ ...simple, weekday: String(value[0]) })} aria-label="Day of the week">
                    {WEEKDAYS.map((day) => (
                      <ToggleGroupItem key={day.value} value={day.value} size="sm">
                        {day.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                )}
                {(simple.frequency === 'daily' || simple.frequency === 'weekly') && (
                  <div className="flex items-center gap-2">
                    At
                    <Input className="w-16" type="number" min={0} max={23} value={simple.hour} onChange={(e) => setSimple({ ...simple, hour: e.target.value })} aria-label="Hour" />:
                    <Input className="w-16" type="number" min={0} max={59} value={simple.minute} onChange={(e) => setSimple({ ...simple, minute: e.target.value })} aria-label="Minute" />
                    {timezone && <span className="text-muted-foreground">{timezone}</span>}
                  </div>
                )}
                {simple.frequency === 'interval' && (
                  <div className="flex items-center gap-2">
                    Every
                    <Input className="w-16" type="number" min={1} max={23} value={simple.everyHours} onChange={(e) => setSimple({ ...simple, everyHours: e.target.value })} aria-label="Hours" />
                    hours
                  </div>
                )}
                <span className="text-muted-foreground">
                  Cron: <code className="font-mono">{toCron(simple)}</code>
                </span>
              </TabsPanel>
              <TabsPanel value="advanced" className="grid gap-3 pt-3">
                {presetItems.length > 0 && (
                  <Select items={presetItems} value={null} onValueChange={(value) => value && setCron(String(value))}>
                    <SelectTrigger>
                      <SelectValue placeholder="Start from a preset" />
                    </SelectTrigger>
                    <SelectPopup>
                      {presetItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
                <Input className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 */2 * * *" maxLength={100} aria-label="Cron expression" />
                <span className="text-muted-foreground">
                  minute (0–59) · hour (0–23) · day (1–31) · month (1–12) · weekday (0–6, Sunday is 0). <code className="font-mono">*</code> is any,{' '}
                  <code className="font-mono">*/n</code> is every n.
                </span>
                {validation && (
                  <span aria-live="polite" className={validation.valid ? 'flex items-center gap-1.5 text-success-foreground' : 'flex items-center gap-1.5 text-destructive-foreground'}>
                    {validation.valid ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                    {validation.valid ? 'Valid expression' : validation.error}
                  </span>
                )}
              </TabsPanel>
            </Tabs>
          </div>

          <div className="grid gap-2 text-sm">
            <span className="font-medium">Command</span>
            <Select items={COMMANDS} value={COMMANDS.some((c) => c.value === command) ? command : null} onValueChange={(value) => value && setCommand(String(value))}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a common command" />
              </SelectTrigger>
              <SelectPopup>
                {COMMANDS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Input className="font-mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Or type any RCON command" maxLength={2000} aria-label="RCON command" />
          </div>

          <div className="grid gap-2 text-sm">
            <span className="font-medium">Server</span>
            <Select items={serverItems} value={serverId || null} onValueChange={(value) => setServerId(String(value ?? ''))}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a server" />
              </SelectTrigger>
              <SelectPopup>
                {serverItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="text-muted-foreground">The task always runs on this server, whichever one is selected when it fires.</span>
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {task ? 'Save task' : 'Create task'}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
