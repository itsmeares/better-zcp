import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Download, Loader2, Trash2, Unplug } from 'lucide-react'
import { serversApi, type ServerInstance } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { panelQueryKeys } from '@/lib/queryClient'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'
import { EmptyState } from '@/components/EmptyState'
import { NumberInput } from '@/components/NumberInput'
import { PageHeader } from '@/components/PageHeader'
import { PasswordInput } from '@/components/PasswordInput'
import { RconTestConnection } from '@/components/RconTestConnection'
import { SaveBar, SettingsCard, SettingsRow } from '@/components/settings-layout'
import { RemoveServerDialog } from '@/components/server/RemoveServerDialog'
import { isCustomLauncherPath } from '@/components/server/SteamOperationDialog'
import { WipeServerDialog } from '@/components/server/WipeServerDialog'
import { useShell } from '@/components/shell/useShellStatus'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toastManager } from '@/components/ui/toast'
import { GameIntegrationSection } from './GameIntegrationSection'
import { GameUpdatesSection } from './GameUpdatesSection'

const SHELL_CHARACTERS = /[&|;<>`${}()!\[\]]/

export const isValidPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535
export const isValidGamePort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65534

const LIFECYCLE_PROVIDERS = [
  { value: 'direct', label: 'Direct (default)' },
  { value: 'systemd', label: 'systemd' },
  { value: 'openrc', label: 'OpenRC' },
]

function validate(draft: ServerInstance): string | null {
  if (!isValidPort(draft.rconPort)) return 'RCON port must be between 1 and 65535.'
  if (!isValidGamePort(draft.serverPort)) return 'Game port must be between 1 and 65534.'
  if (!Number.isFinite(draft.minMemory) || !Number.isFinite(draft.maxMemory)) return 'Enter a minimum and maximum memory value.'
  if (draft.startCommand && SHELL_CHARACTERS.test(draft.startCommand)) return 'The start command contains characters the panel refuses for safety.'
  return null
}

function LifecycleProvider({ server, onActivated }: { server: ServerInstance; onActivated: () => void }) {
  const confirm = useConfirm()
  const [provider, setProvider] = useState(server.lifecycleProvider || 'direct')
  const [busy, setBusy] = useState(false)
  const current = server.lifecycleProvider || 'direct'

  useEffect(() => setProvider(server.lifecycleProvider || 'direct'), [server.lifecycleProvider])

  const downloadServiceFile = async () => {
    if (provider === 'direct') return
    setBusy(true)
    try {
      const template = await serversApi.getLifecycleTemplate(server.id, provider)
      const url = URL.createObjectURL(new Blob([template.content], { type: 'text/plain;charset=utf-8' }))
      const anchor = Object.assign(document.createElement('a'), { href: url, download: template.filename })
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      toastManager.add({ title: 'Service file generated', description: `Review it, then install it at ${template.installPath} as an administrator.` })
    } catch (error) {
      toastManager.add({ title: "Couldn't generate the service file", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const activate = async () => {
    const ok = await confirm({
      title: 'Change who runs this server?',
      description: `Switch this server from ${current} to ${provider}? The panel refuses if a process is running, the service is missing, or its ownership marker conflicts.`,
      confirmLabel: 'Switch provider',
      variant: 'warning',
    })
    if (!ok) return
    setBusy(true)
    try {
      const result = await serversApi.activateLifecycleProvider(server.id, provider)
      toastManager.add({ title: 'Lifecycle provider switched', description: result.message, type: 'success' })
      onActivated()
    } catch (error) {
      toastManager.add({ title: "Couldn't switch the provider", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard
      title="Who runs the process"
      description="Direct runs the game server as a child of the panel. systemd and OpenRC keep it in its own operating-system service. Install the generated service file and stop every running copy before switching. The panel never writes to /etc or runs sudo."
    >
      <SettingsRow label="Lifecycle provider" description={provider === current ? `Currently ${current}.` : `Currently ${current}. Switch to apply ${provider}.`}>
        <Select items={LIFECYCLE_PROVIDERS} value={provider} onValueChange={(value) => setProvider(value as typeof provider)} disabled={busy}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {LIFECYCLE_PROVIDERS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </SettingsRow>
      {provider !== 'direct' && (
        <SettingsRow label="Service file" description="Generated for this server's paths and settings.">
          <Button variant="outline" size="sm" onClick={() => void downloadServiceFile()} disabled={busy}>
            <Download />
            Download
          </Button>
        </SettingsRow>
      )}
      {provider !== current && (
        <div className="flex justify-end py-4">
          <Button onClick={() => void activate()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Switch to {provider}
          </Button>
        </div>
      )}
    </SettingsCard>
  )
}

export default function ServerSettingsPage() {
  const { selectedServer: server, runState, serversConfirmedEmpty } = useShell()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const runtimeInfo = useRuntimeInfo()
  const { data: serversData } = useQuery({ queryKey: panelQueryKeys.servers, queryFn: serversApi.getAll, staleTime: 30_000 })
  const lifecycleSupported = serversData?.lifecycleCapabilities?.supported === true
  const [draft, setDraft] = useState<ServerInstance | null>(server)
  const [saving, setSaving] = useState(false)
  const [wipeOpen, setWipeOpen] = useState(false)
  const [removing, setRemoving] = useState<ServerInstance | null>(null)

  const isDirty = !!draft && !!server && JSON.stringify(draft) !== JSON.stringify(server)

  // Follow the stored server unless the admin has unsaved edits.
  useEffect(() => {
    if (!isDirty) setDraft(server)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isDirty is derived from draft; re-running on it would undo edits
  }, [server])

  const refreshServers = () => queryClient.invalidateQueries({ queryKey: panelQueryKeys.servers })

  const save = async () => {
    if (!draft || saving) return
    const problem = validate(draft)
    if (problem) {
      toastManager.add({ title: "Can't save yet", description: problem, type: 'error' })
      return
    }
    setSaving(true)
    try {
      // The provider is switched separately; never send an unapplied choice.
      const result = await serversApi.update(draft.id, { ...draft, lifecycleProvider: server?.lifecycleProvider })
      const warnings = result.warnings?.filter(Boolean) ?? []
      toastManager.add({ title: 'Server settings saved', description: warnings.join(' ') || undefined, type: warnings.length ? 'warning' : 'success' })
      await refreshServers()
    } catch (error) {
      toastManager.add({ title: "Couldn't save server settings", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  usePageShortcut(
    's',
    () => {
      if (isDirty) void save()
    },
    { ctrl: true },
  )

  if (!server || !draft) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Server settings" />
        <EmptyState
          type="serverOffline"
          title={serversConfirmedEmpty ? 'No server yet' : 'Loading the server'}
          description={serversConfirmedEmpty ? 'Add a server to manage its settings here.' : undefined}
          action={serversConfirmedEmpty ? { label: 'Add a server', to: '/servers/new', variant: 'default' } : undefined}
        />
      </div>
    )
  }

  const set = <K extends keyof ServerInstance>(key: K, value: ServerInstance[K]) => setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
  const running = runState === 'running' || runState === 'transitioning'
  const scriptExample =
    runtimeInfo?.family === 'windows' ? 'StartServer64.bat -servername MyServer' : runtimeInfo?.family === 'posix' ? './start-server.sh -servername MyServer' : 'Command used to start this server'

  return (
    <div className="grid gap-6 pb-20">
      <PageHeader title="Server settings" description={`How the panel finds, starts and talks to ${server.name}. Most changes apply on the next start.`} />

      <SettingsCard title="Profile">
        <SettingsRow label="Display name" htmlFor="server-display-name" description="How this server appears in the panel.">
          <Input id="server-display-name" className="w-64" value={draft.name} maxLength={100} onChange={(e) => set('name', e.target.value)} />
        </SettingsRow>
        <SettingsRow
          label="Server name"
          htmlFor="server-name"
          description="Must match the server's real internal name: its .ini file and save folder, such as servertest.ini and Saves/Multiplayer/servertest. Changing it doesn't rename files."
        >
          <Input id="server-name" className="w-64 font-mono" value={draft.serverName} maxLength={64} onChange={(e) => set('serverName', e.target.value)} />
        </SettingsRow>
        <SettingsRow label="Game port" description="Project Zomboid also uses the next port up.">
          <NumberInput className="w-32" min={1} max={65534} value={draft.serverPort} onChange={(serverPort) => set('serverPort', serverPort)} />
        </SettingsRow>
        <SettingsRow label="Memory" description="Java heap in GB.">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <NumberInput className="w-24" min={1} max={64} value={draft.minMemory} clamp={(n) => Math.max(1, n)} onChange={(minMemory) => set('minMemory', minMemory)} />
            to
            <NumberInput className="w-24" min={1} max={64} value={draft.maxMemory} clamp={(n) => Math.max(1, n)} onChange={(maxMemory) => set('maxMemory', maxMemory)} />
            GB
          </div>
        </SettingsRow>
        <SettingsRow label="Admin password" description="Passed to the server as -adminpassword on the next start.">
          <PasswordInput className="w-64" value={draft.adminPassword || ''} onChange={(value) => set('adminPassword', value)} placeholder="Set admin password" label="admin password" />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Files and launch">
        <SettingsRow label="Install folder" htmlFor="install-path" stacked description="The Project Zomboid dedicated server folder, or a launch script inside it.">
          <div className="grid w-full gap-2">
            <Input id="install-path" className="font-mono" value={draft.installPath} onChange={(e) => set('installPath', e.target.value)} />
            {isCustomLauncherPath(draft.installPath) && (
              <Alert variant="warning">
                <AlertTitle>Custom launcher</AlertTitle>
                <AlertDescription>
                  This points at a script, so the panel runs it as-is and never edits it. Memory, the admin password, the data folder and the server name only reach
                  the server if you put them in the script yourself.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          label="Zomboid data folder"
          htmlFor="data-path"
          stacked
          description="Holds the saves, config and logs (Saves/, Server/, Logs/). Changing it doesn't move files. Point it at the wrong folder and backups and wipes act on the wrong data."
        >
          <Input id="data-path" className="font-mono" value={draft.zomboidDataPath || ''} placeholder="Default location" onChange={(e) => set('zomboidDataPath', e.target.value)} />
        </SettingsRow>
        <SettingsRow
          label="Custom start command"
          htmlFor="start-command"
          stacked
          description="Leave empty and the panel rewrites the default start script from these settings on every start, backing up a changed file first."
        >
          <div className="grid w-full gap-1.5">
            <Input id="start-command" className="font-mono" value={draft.startCommand || ''} maxLength={1024} placeholder={scriptExample} onChange={(e) => set('startCommand', e.target.value)} />
            {draft.startCommand && SHELL_CHARACTERS.test(draft.startCommand) && (
              <p className="text-sm text-destructive-foreground">The command contains characters the panel refuses for safety: &amp; | ; &lt; &gt; ` $ ( ) ! [ ]</p>
            )}
          </div>
        </SettingsRow>
        <SettingsRow label="Launch without Steam" htmlFor="no-steam" description="Use the non-Steam dedicated server mode on the next start.">
          <Checkbox id="no-steam" checked={!!draft.useNoSteam} onCheckedChange={(checked) => set('useNoSteam', checked === true)} />
        </SettingsRow>
        <SettingsRow
          label="Docker container"
          htmlFor="docker-container"
          description="Optional. Needs PANEL_DOCKER_CONTROL_ENABLED and the container label zomboid-panel.managed=true."
        >
          <Input
            id="docker-container"
            className="w-64 font-mono"
            value={draft.dockerContainerName || ''}
            maxLength={128}
            placeholder="Container name"
            onChange={(e) => set('dockerContainerName', e.target.value || null)}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="RCON" description="The remote console the panel uses for commands, saves and player actions.">
        <SettingsRow label="Host" htmlFor="rcon-host" description="Use 127.0.0.1 when the panel and server run on the same machine.">
          <Input id="rcon-host" className="w-64 font-mono" value={draft.rconHost} placeholder="127.0.0.1" onChange={(e) => set('rconHost', e.target.value)} />
        </SettingsRow>
        <SettingsRow label="Port">
          <NumberInput className="w-32" min={1} max={65535} value={draft.rconPort} onChange={(rconPort) => set('rconPort', rconPort)} />
        </SettingsRow>
        <SettingsRow label="Password" description="Must match RCONPassword in the server's .ini.">
          <PasswordInput className="w-64" value={draft.rconPassword} onChange={(value) => set('rconPassword', value)} label="RCON password" />
        </SettingsRow>
        <div className="flex justify-end py-4">
          <RconTestConnection host={draft.rconHost} port={draft.rconPort} password={draft.rconPassword} className="justify-items-end text-end" />
        </div>
      </SettingsCard>

      {lifecycleSupported && !server.dockerContainerName && !server.dockerContainerId && <LifecycleProvider server={server} onActivated={() => void refreshServers()} />}

      <GameIntegrationSection />
      <GameUpdatesSection server={server} isDirty={isDirty} />

      <SettingsCard title="Danger zone" className="border-destructive/32">
        <SettingsRow
          label="Wipe the world"
          description={running ? 'Stop the server before wiping.' : 'Delete the map, players, world state or accounts. You see what will be deleted first, and a backup is made unless you turn it off.'}
        >
          <Button variant="destructive-outline" disabled={running} onClick={() => setWipeOpen(true)}>
            <Trash2 />
            Wipe…
          </Button>
        </SettingsRow>
        <SettingsRow label="Remove from the panel" description="Stop managing this server. Its files stay unless you choose to delete them.">
          <Button variant="destructive-outline" onClick={() => setRemoving(server)}>
            <Unplug />
            Remove…
          </Button>
        </SettingsRow>
      </SettingsCard>

      <WipeServerDialog open={wipeOpen} onOpenChange={setWipeOpen} serverName={server.name} />
      <RemoveServerDialog
        server={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null)
          void refreshServers()
          void navigate({ to: '/servers', search: { server: undefined } })
        }}
      />

      {isDirty && (
        <SaveBar message="Unsaved changes" saving={saving} onSave={() => void save()} onDiscard={() => setDraft(server)} />
      )}
    </div>
  )
}
