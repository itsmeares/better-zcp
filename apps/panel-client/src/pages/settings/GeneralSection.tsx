import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RotateCw } from 'lucide-react'
import { serverApi, serversApi, type RestartAssessment } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { panelQueryKeys } from '@/lib/queryClient'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { useTheme, type ThemeName } from '@/contexts/ThemeContext'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toastManager } from '@/components/ui/toast'
import type { AppSettingsState } from './useAppSettings'

const THEMES: { value: ThemeName; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function normalizePort(value: string): string {
  const parsed = Number.parseInt(value, 10)
  return isValidPort(parsed) ? String(parsed) : '3001'
}

export function restartAssessmentMessage(assessment: RestartAssessment | undefined, scope: 'general' | 'updates') {
  if (assessment?.gameServers === 'preserved') {
    return scope === 'general' ? 'Running game servers will stay online.' : 'Running game servers will stay online during this update.'
  }
  if (assessment?.gameServers === 'at-risk') {
    return scope === 'general' ? 'Restarting the panel may stop running game servers.' : 'This update may stop running game servers.'
  }
  return scope === 'general'
    ? "The panel can't tell whether running game servers will stay online."
    : "The panel can't tell whether running game servers will stay online during this update."
}

function RestartPanelButton({ port, disabled }: { port: string; disabled: boolean }) {
  const runtimeInfo = useRuntimeInfo()
  const assessment = runtimeInfo?.restartAssessment
  const risky = assessment?.gameServers !== 'preserved' || Boolean(assessment?.requiresConfirmation)
  const [open, setOpen] = useState(false)
  const [riskConfirmed, setRiskConfirmed] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  const restart = async () => {
    setOpen(false)
    setRestarting(true)
    try {
      await serverApi.restartPanel()
      toastManager.add({ title: 'Restarting the panel', description: `Reconnecting on port ${port}…` })
      timeoutRef.current = setTimeout(() => {
        const { protocol, hostname, pathname, search, hash } = window.location
        window.location.href = `${protocol}//${hostname}:${normalizePort(port)}${pathname}${search}${hash}`
      }, 3000)
    } catch (error) {
      setRestarting(false)
      const code = (error as { code?: string })?.code
      toastManager.add(
        code === 'apply_in_progress'
          ? { title: 'An update is already running', description: getUserErrorMessage(error, 'Wait for the panel to reconnect.') }
          : { title: 'Restart failed', description: 'Could not restart the panel. You may need to restart it by hand.', type: 'error' },
      )
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setRiskConfirmed(false)
      }}
    >
      <Button variant="outline" disabled={disabled || restarting} onClick={() => setOpen(true)}>
        {restarting ? <Loader2 className="animate-spin" /> : <RotateCw />}
        {restarting ? 'Restarting…' : 'Restart panel'}
      </Button>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart the panel?</AlertDialogTitle>
          <AlertDialogDescription>{restartAssessmentMessage(assessment, 'general')}</AlertDialogDescription>
          {risky && (
            <label className="mt-3 flex items-start gap-2 text-sm">
              <Checkbox checked={riskConfirmed} onCheckedChange={(checked) => setRiskConfirmed(checked === true)} />
              <span>I understand that running game servers may be stopped.</span>
            </label>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button disabled={risky && !riskConfirmed} onClick={() => void restart()}>
            Restart panel
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}

export function GeneralSection({ state }: { state: AppSettingsState }) {
  const { settings, saved, update, isDirty } = state
  const { theme, setTheme } = useTheme()
  const { data: serversData } = useQuery({ queryKey: panelQueryKeys.servers, queryFn: serversApi.getAll, staleTime: 30_000 })
  // Auto-start applies to the panel's default server, not to the server selected in this tab.
  const defaultServer = serversData?.servers.find((server) => server.isActive)
  const portChanged = saved !== null && settings.panelPort !== saved.panelPort

  return (
    <div className="grid gap-4">
      <SettingsCard title="Panel" description="Where this admin panel listens.">
        <SettingsRow label="Panel port" htmlFor="panel-port" description="Port used to open the panel. The default is 3001.">
          <Input
            id="panel-port"
            className="w-32"
            type="number"
            inputMode="numeric"
            min={1024}
            max={65535}
            value={settings.panelPort}
            onChange={(e) => update('panelPort', e.target.value)}
            onWheel={(e) => e.currentTarget.blur()}
          />
        </SettingsRow>
        <SettingsRow label="Restart the panel" description={isDirty ? 'Save your changes before restarting.' : 'Needed after changing the port.'}>
          <RestartPanelButton port={settings.panelPort} disabled={isDirty} />
        </SettingsRow>
        {portChanged && (
          <div className="pb-4">
            <Alert variant="warning">
              <AlertTitle>Restart required</AlertTitle>
              <AlertDescription>A new port takes effect after you save and restart the panel.</AlertDescription>
            </Alert>
          </div>
        )}
      </SettingsCard>

      <SettingsCard title="Appearance">
        <SettingsRow label="Theme" description="Follow your system, or always use light or dark.">
          <Select items={THEMES} value={theme} onValueChange={(value) => setTheme(value as ThemeName)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {THEMES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Game servers" description="How the panel starts and talks to the game server.">
        <SettingsRow
          label="Start the game server when the panel starts"
          htmlFor="auto-start-server"
          description={
            <>
              Starts {defaultServer ? <strong className="font-medium text-foreground">{defaultServer.name}</strong> : 'the default server'}.
              It's skipped when the RCON port is already in use, so a running server is never started twice. Needs a local install;
              servers run by a host provider are started by the provider.
            </>
          }
        >
          <Switch id="auto-start-server" checked={settings.autoStartServer} onCheckedChange={(value) => update('autoStartServer', value)} />
        </SettingsRow>
        <SettingsRow label="Reconnect RCON automatically" htmlFor="auto-reconnect" description="Keep retrying when the RCON connection drops.">
          <Switch id="auto-reconnect" checked={settings.autoReconnect} onCheckedChange={(value) => update('autoReconnect', value)} />
        </SettingsRow>
        {settings.autoReconnect && (
          <SettingsRow label="Reconnect every" htmlFor="reconnect-interval" description="Seconds between attempts, from 1 to 60.">
            <div className="flex items-center gap-2">
              <Input
                id="reconnect-interval"
                className="w-24"
                type="number"
                inputMode="numeric"
                min={1}
                max={60}
                value={settings.reconnectInterval}
                onChange={(e) => update('reconnectInterval', e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
              />
              <span className="text-sm text-muted-foreground">seconds</span>
            </div>
          </SettingsRow>
        )}
      </SettingsCard>
    </div>
  )
}
