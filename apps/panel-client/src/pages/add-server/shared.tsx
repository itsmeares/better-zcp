import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronLeft, ChevronRight, Copy, FolderOpen, Play, RefreshCw } from 'lucide-react'
import { debugApi, serverApi, serversApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { selectServer } from '@/lib/serverSelection'
import { cn, copyText } from '@/lib/utils'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { FolderBrowser } from '@/components/FolderBrowser'
import { NumberInput } from '@/components/NumberInput'
import { PasswordInput } from '@/components/PasswordInput'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Switch } from '@/components/ui/switch'
import { toastManager } from '@/components/ui/toast'

export const isValidInstallPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535
export const isValidNewGamePort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65534

function generatePassword(length = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const values = crypto.getRandomValues(new Uint32Array(length))
  return Array.from(values, (value) => chars[value % chars.length]).join('')
}

/** Fields shared by installing a new server and setting up downloaded files. */
export function useNewServerForm() {
  const [form, setForm] = useState({
    installPath: '',
    serverName: 'myserver',
    useCustomDataPath: false,
    zomboidDataPath: '',
    rconPassword: generatePassword(),
    rconPort: 27015,
    adminPassword: '',
    minMemory: 4,
    maxMemory: 8,
    serverPort: 16261,
    useUpnp: true,
    useNoSteam: false,
    useDebug: false,
  })
  const [systemRam, setSystemRam] = useState<{ totalGB: number } | null>(null)
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((prev) => ({ ...prev, [key]: value }))

  useEffect(() => {
    debugApi
      .getRam()
      .then((data) => {
        setSystemRam({ totalGB: data.totalGB })
        setForm((prev) => ({ ...prev, minMemory: data.recommendedMin, maxMemory: data.recommendedMax }))
      })
      .catch(() => {})
  }, [])

  const settingsProblem =
    form.rconPassword.length < 6
      ? 'The RCON password needs at least 6 characters.'
      : !form.adminPassword.trim()
        ? 'Set an admin password.'
        : !isValidNewGamePort(form.serverPort) || !isValidInstallPort(form.rconPort)
          ? 'Use a game port from 1024 to 65534 and an RCON port from 1024 to 65535.'
          : null

  return { form, set, setForm, systemRam, settingsProblem, regeneratePassword: () => set('rconPassword', generatePassword()) }
}

export type NewServerForm = ReturnType<typeof useNewServerForm>

/** A path input with a Browse button that opens the panel's folder browser. */
export function PathInput({ value, onChange, placeholder, browseTitle, id, disabled }: { value: string; onChange: (value: string) => void; placeholder?: string; browseTitle: string; id?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <InputGroup>
        <InputGroupInput id={id} className="font-mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={260} disabled={disabled} />
        <InputGroupAddon align="inline-end">
          <Button type="button" variant="ghost" size="icon-xs" aria-label={browseTitle} onClick={() => setOpen(true)} disabled={disabled}>
            <FolderOpen />
          </Button>
        </InputGroupAddon>
      </InputGroup>
      <FolderBrowser open={open} onOpenChange={setOpen} onSelect={onChange} initialPath={value || undefined} title={browseTitle} />
    </>
  )
}

/** RCON, admin password, memory and advanced launch options for a new server. */
export function ServerSettingsFields({ state, showDataPath = true }: { state: NewServerForm; showDataPath?: boolean }) {
  const { form, set, systemRam, regeneratePassword } = state
  const runtimeInfo = useRuntimeInfo()
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
  }, [])

  return (
    <div className="grid gap-4">
      <SettingsCard title="Remote control" description="The panel sends commands to the running game over RCON. The password is generated for you and the panel remembers it.">
        <SettingsRow label="RCON password" description={form.rconPassword.length > 0 && form.rconPassword.length < 6 ? <span className="text-destructive-foreground">Use at least 6 characters.</span> : undefined}>
          <div className="flex items-center gap-1">
            <PasswordInput className="w-56" value={form.rconPassword} onChange={(value) => set('rconPassword', value)} label="RCON password" maxLength={128} />
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy password"
              onClick={() => {
                void copyText(form.rconPassword)
                setCopied(true)
                if (copiedTimer.current) clearTimeout(copiedTimer.current)
                copiedTimer.current = setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
            <Button variant="outline" size="icon" aria-label="Generate a new password" onClick={regeneratePassword}>
              <RefreshCw />
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow label="RCON port" description="Must be free on this machine. The default is 27015.">
          <NumberInput className="w-32 font-mono" min={1024} max={65535} value={form.rconPort} onChange={(value) => set('rconPort', value)} />
        </SettingsRow>
        <SettingsRow
          label="Admin password"
          description="The in-game admin account's password. Once the server runs, type /login admin and this password in chat for admin powers. The server won't start without one."
        >
          <PasswordInput className="w-64" value={form.adminPassword} onChange={(value) => set('adminPassword', value)} label="admin password" placeholder="Required" maxLength={128} />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Memory" description={systemRam ? `This machine has ${systemRam.totalGB} GB. Leave headroom for the operating system.` : 'Leave headroom for the operating system.'}>
        <SettingsRow label="Java heap" description="Minimum is reserved at start. Maximum is the ceiling the server can grow to.">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <NumberInput
              className="w-20"
              min={1}
              max={64}
              value={form.minMemory}
              clamp={(n) => Math.min(64, Math.max(1, n))}
              aria-label="Minimum memory in GB"
              onChange={(value) => state.setForm((prev) => ({ ...prev, minMemory: value, maxMemory: Math.max(prev.maxMemory, value) }))}
            />
            to
            <NumberInput
              className="w-20"
              min={1}
              max={128}
              value={form.maxMemory}
              clamp={(n) => Math.min(128, Math.max(1, n))}
              aria-label="Maximum memory in GB"
              onChange={(value) => state.setForm((prev) => ({ ...prev, maxMemory: value, minMemory: Math.min(prev.minMemory, value) }))}
            />
            GB
          </div>
        </SettingsRow>
      </SettingsCard>

      <Collapsible className="rounded-2xl border">
        <CollapsibleTrigger className="flex w-full items-center justify-between px-6 py-4 text-sm font-medium">
          Advanced options
          <ChevronRight className="size-4 transition-transform in-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="grid border-t px-6">
            {showDataPath && (
              <SettingsRow
                label="Custom data folder"
                stacked
                description="Saves, config and logs normally go in a folder beside the install folder. Only change this if they live somewhere else, such as another drive or a bind-mounted Docker folder."
              >
                <div className="grid w-full gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={form.useCustomDataPath} onCheckedChange={(value) => set('useCustomDataPath', value)} />
                    Use a custom folder
                  </label>
                  {form.useCustomDataPath && (
                    <PathInput
                      value={form.zomboidDataPath}
                      onChange={(value) => set('zomboidDataPath', value)}
                      browseTitle="Choose the data folder"
                      placeholder={runtimeInfo?.family === 'windows' ? 'C:\\Users\\you\\Zomboid' : '/home/you/Zomboid'}
                    />
                  )}
                </div>
              </SettingsRow>
            )}
            <SettingsRow label="Game port" description="Players connect here. The next port up is used too. The default is 16261.">
              <NumberInput className="w-32 font-mono" min={1024} max={65534} value={form.serverPort} onChange={(value) => set('serverPort', value)} />
            </SettingsRow>
            <SettingsRow label="UPnP" description="Try to forward ports on the router automatically.">
              <Switch checked={form.useUpnp} onCheckedChange={(value) => set('useUpnp', value)} aria-label="UPnP" />
            </SettingsRow>
            <SettingsRow label="Launch without Steam" description="For GOG and LAN setups.">
              <Switch checked={form.useNoSteam} onCheckedChange={(value) => set('useNoSteam', value)} aria-label="Launch without Steam" />
            </SettingsRow>
            <SettingsRow label="Debug logging" description="Verbose startup and runtime logs.">
              <Switch checked={form.useDebug} onCheckedChange={(value) => set('useDebug', value)} aria-label="Debug logging" />
            </SettingsRow>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  )
}

export interface SetupLogLine {
  type: 'info' | 'success' | 'error' | 'warning' | 'stdout' | 'stderr'
  message: string
}

export function SetupLog({ lines, running }: { lines: SetupLogLine[]; running?: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [lines])
  if (lines.length === 0) return null
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border bg-muted p-3 font-mono text-xs leading-relaxed" role="log" aria-live="polite">
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            (line.type === 'error' || line.type === 'stderr') && 'text-destructive-foreground',
            line.type === 'warning' && 'text-warning-foreground',
            line.type === 'success' && 'text-success-foreground',
          )}
        >
          {line.message}
        </div>
      ))}
      {running && <div className="animate-pulse text-muted-foreground">…</div>}
      <div ref={end} />
    </div>
  )
}

/** Saves the new server profile and selects it. Returns false if either step failed. */
export async function registerServer(profile: Parameters<typeof serversApi.create>[0], log: (line: SetupLogLine) => void): Promise<boolean> {
  let id: string | number | undefined
  try {
    id = (await serversApi.create(profile)).server?.id
    log({ type: 'success', message: 'Server added to the panel.' })
  } catch (error) {
    reportClientError('Failed to create server entry.', error)
    log({ type: 'error', message: "The files are ready, but the panel couldn't add the server." })
    toastManager.add({
      title: "Files ready, but the server wasn't added",
      description: "The game files are on disk, but the panel couldn't save this server. Check the log, then run setup again; it's safe to repeat.",
      type: 'error',
    })
    return false
  }
  if (id === undefined) return true
  try {
    await selectServer(id)
    log({ type: 'success', message: 'Switched to the new server.' })
    return true
  } catch (error) {
    reportClientError('Failed to activate newly created server.', error)
    log({ type: 'error', message: "The server was added, but the panel couldn't switch to it." })
    toastManager.add({ title: "Added, but not selected", description: 'Pick the new server in the server switcher before starting it.', type: 'error' })
    return false
  }
}

export function SetupComplete({ title, firstStart }: { title: string; firstStart?: boolean }) {
  const navigate = useNavigate()
  const [starting, setStarting] = useState(false)
  const start = async () => {
    setStarting(true)
    try {
      await serverApi.start()
      toastManager.add({ title: 'Server starting', description: 'Taking you to Overview…' })
      void navigate({ to: '/' })
    } catch (error) {
      toastManager.add({ title: "The server didn't start", description: getUserErrorMessage(error, 'Unknown error.'), type: 'error' })
    } finally {
      setStarting(false)
    }
  }
  return (
    <Alert variant="success">
      <Check />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {firstStart && <p>Start the server once to create its config files and world. The first start can take a minute.</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void start()} disabled={starting}>
            <Play />
            {starting ? 'Starting…' : 'Start server'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/' })}>
            Open Overview
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

/** Numbered steps with Back and Next. The last step owns its own action buttons. */
export function Wizard({
  steps,
  step,
  onStep,
  onExit,
  canProceed,
  blocker,
  busy,
  children,
}: {
  steps: string[]
  step: number
  onStep: (step: number) => void
  onExit: () => void
  canProceed: boolean
  blocker?: string | null
  busy?: boolean
  children: ReactNode
}) {
  const last = step === steps.length - 1
  return (
    <div className="grid gap-5">
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {steps.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={index === step ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1',
                index === step ? 'border-primary bg-primary text-primary-foreground' : index < step ? 'bg-accent' : 'text-muted-foreground',
              )}
            >
              <span className="tabular-nums">{index + 1}</span>
              {label}
            </span>
            {index < steps.length - 1 && <span className="h-px w-4 bg-border" aria-hidden />}
          </li>
        ))}
      </ol>
      {children}
      {!busy && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="outline" onClick={() => (step === 0 ? onExit() : onStep(step - 1))}>
            <ChevronLeft />
            {step === 0 ? 'Choose another way' : 'Back'}
          </Button>
          {!last && (
            <div className="flex items-center gap-3">
              {!canProceed && blocker && <span className="text-sm text-warning-foreground">{blocker}</span>}
              <Button onClick={() => onStep(step + 1)} disabled={!canProceed}>
                Next
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ReviewList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y rounded-2xl border text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 px-4 py-2.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate text-end font-mono" title={typeof value === 'string' ? value : undefined}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

