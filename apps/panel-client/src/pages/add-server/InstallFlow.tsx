import { useContext, useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, Loader2 } from 'lucide-react'
import { configApi, serverApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage, rawErrorMessageIntentional } from '@/lib/errorMessage'
import { getInstallProgressMessage } from '@/lib/installProgressMessage'
import { SocketContext } from '@/contexts/SocketContext'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toastManager } from '@/components/ui/toast'
import { PathInput, registerServer, ReviewList, ServerSettingsFields, SetupComplete, SetupLog, useNewServerForm, Wizard, type SetupLogLine } from './shared'
import { formatBytes } from '@/lib/utils'

const LINUX_SERVICE_INSTALL_PATH = '/opt/zomboid-panel/data/pzserver'
export const INSTALL_INFLIGHT_KEY = 'zcp-install-inflight'
const INSTALL_INFLIGHT_STALE_MS = 6 * 60 * 60 * 1000

export interface InstallInFlightMarker {
  installPath: string
  serverName: string
  startedAt: number
}

/** A recent install that a reload or closed tab may have interrupted. */
export function readInstallInFlightMarker(): InstallInFlightMarker | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(INSTALL_INFLIGHT_KEY) || 'null')
    if (!parsed || typeof parsed.installPath !== 'string' || typeof parsed.serverName !== 'string' || typeof parsed.startedAt !== 'number') return null
    if (Date.now() - parsed.startedAt > INSTALL_INFLIGHT_STALE_MS) {
      clearInstallInFlightMarker()
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearInstallInFlightMarker() {
  try {
    localStorage.removeItem(INSTALL_INFLIGHT_KEY)
  } catch {
    // Storage may be unavailable; the marker only powers a reminder.
  }
}

function writeInstallInFlightMarker(marker: InstallInFlightMarker) {
  try {
    localStorage.setItem(INSTALL_INFLIGHT_KEY, JSON.stringify(marker))
  } catch {
    // Best effort: without it the panel just can't remind you after a reload.
  }
}

export function installationErrorGuidance(rawMessage: string, displayMessage: string, platform: string | null) {
  if (!rawMessage.startsWith('Installation path is not writable:') || platform !== 'linux') return displayMessage
  return `${rawMessage} On Linux, use ${LINUX_SERVICE_INSTALL_PATH}, or add both your install folder and its _Data folder to ReadWritePaths in zomboid-panel.service, then restart the service.`
}


type Progress = { percent: number; detail: string; status: string }

export function InstallFlow({ onExit, resume }: { onExit: () => void; resume?: InstallInFlightMarker | null }) {
  const socket = useContext(SocketContext)
  const runtimeInfo = useRuntimeInfo()
  const state = useNewServerForm()
  const { form, set, settingsProblem } = state
  const [step, setStep] = useState(resume ? 1 : 0)
  const [steamCmdPath, setSteamCmdPath] = useState('')
  const [hasSteamCmd, setHasSteamCmd] = useState(false)
  const [downloadingSteamCmd, setDownloadingSteamCmd] = useState(false)
  const [steamCmdStatus, setSteamCmdStatus] = useState('')
  const [branch, setBranch] = useState('public')
  const [branches, setBranches] = useState<Array<{ name: string; description: string; buildId?: string | null }>>([{ name: 'public', description: 'Stable release (Build 42)' }])
  const [installing, setInstalling] = useState(false)
  const [complete, setComplete] = useState(false)
  const [logs, setLogs] = useState<SetupLogLine[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const installing_ = useRef(false)
  const formRef = useRef(form)
  formRef.current = form
  const log = (line: SetupLogLine) => setLogs((prev) => [...prev, line])

  useEffect(() => {
    if (resume) state.setForm((prev) => ({ ...prev, installPath: resume.installPath, serverName: resume.serverName }))
    configApi
      .getAppSettings()
      .then(({ settings = {} }) => {
        if (settings.steamcmdPath) {
          setSteamCmdPath(String(settings.steamcmdPath))
          setHasSteamCmd(true)
        }
      })
      .catch((error) => reportClientError('Failed to load settings.', error))
    // Mount-only: seeds the form once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!hasSteamCmd || !steamCmdPath) return
    serverApi
      .getBranches(steamCmdPath)
      .then((data) => {
        if (!Array.isArray(data.branches)) return
        setBranches(data.branches)
        setBranch((current) => (data.branches.some((b: { name: string }) => b.name === current) ? current : 'public'))
      })
      .catch((error) => reportClientError('Failed to fetch branches.', error))
  }, [hasSteamCmd, steamCmdPath])

  useEffect(() => {
    if (!socket) return
    type Coded = { progressCode?: string; params?: Record<string, string | number> }

    const onInstallLog = (data: Coded & { type: 'stdout' | 'stderr'; text: string }) => {
      const text = data.text.trim()
      log({ type: data.type, message: getInstallProgressMessage(data, text) })
      const download = text.match(/progress:\s*([\d.]+)\s*\(([\d,]+)\s*\/\s*([\d,]+)\)/)
      if (download) {
        setProgress({
          percent: parseFloat(download[1]),
          detail: `${formatBytes(parseInt(download[2].replace(/,/g, '')))} of ${formatBytes(parseInt(download[3].replace(/,/g, '')))}`,
          status: 'Downloading',
        })
      }
      const validate = text.match(/[Vv]alidat\w*[^\d]*(\d+)%/)
      if (validate) setProgress({ percent: parseInt(validate[1]), detail: '', status: 'Validating files' })
      if (text.includes('Update state') && text.includes('verifying')) setProgress((prev) => (prev ? { ...prev, status: 'Verifying the installation' } : null))
      if (text.includes('Success!') || text.includes('fully installed')) setProgress({ percent: 100, detail: '', status: 'Done' })
    }

    const onInstallComplete = async (
      data: Coded & {
        success: boolean
        message: string
        installPath?: string
        serverName?: string
        zomboidDataPath?: string
        serverConfigPath?: string
        branch?: string
        rconPort?: number
        rconPassword?: string
        serverPort?: number
        minMemory?: number
        maxMemory?: number
        warnings?: Array<Coded & { message: string }>
      },
    ) => {
      if (!installing_.current) return
      installing_.current = false
      clearInstallInFlightMarker()
      const message = getInstallProgressMessage(data, data.message)
      try {
        if (!data.success) {
          log({ type: 'error', message })
          toastManager.add({ title: 'Installation failed', description: message, type: 'error' })
          return
        }
        log({ type: 'success', message })
        for (const warning of data.warnings ?? []) log({ type: 'warning', message: getInstallProgressMessage(warning, warning.message) })
        const f = formRef.current
        const ok = await registerServer(
          {
            name: data.serverName || f.serverName,
            serverName: data.serverName || f.serverName,
            installPath: data.installPath || f.installPath,
            zomboidDataPath: data.zomboidDataPath || null,
            serverConfigPath: data.serverConfigPath || null,
            branch: data.branch,
            rconHost: '127.0.0.1',
            rconPort: data.rconPort || f.rconPort,
            rconPassword: data.rconPassword || f.rconPassword,
            adminPassword: f.adminPassword,
            serverPort: data.serverPort || f.serverPort,
            minMemory: data.minMemory || f.minMemory,
            maxMemory: data.maxMemory || f.maxMemory,
            useNoSteam: f.useNoSteam,
            useDebug: f.useDebug,
            useUpnp: f.useUpnp,
          },
          log,
        )
        if (ok) {
          setComplete(true)
          toastManager.add({ title: 'Server installed', type: 'success' })
        }
      } finally {
        setInstalling(false)
      }
    }

    const onSteamCmdStatus = (data: Coded & { status: string; message: string; path?: string }) => {
      const message = getInstallProgressMessage(data, data.message)
      setSteamCmdStatus(message)
      if (installing_.current) log({ type: data.status === 'complete' ? 'success' : data.status === 'error' ? 'error' : 'info', message })
      if (data.status === 'complete' && data.path) {
        setSteamCmdPath(data.path)
        setHasSteamCmd(true)
        setDownloadingSteamCmd(false)
        toastManager.add({ title: 'SteamCMD is ready', type: 'success' })
      } else if (data.status === 'error') {
        setDownloadingSteamCmd(false)
        toastManager.add({ title: "SteamCMD setup didn't finish", description: message, type: 'error' })
      }
    }
    const onSteamCmdLog = (data: Coded & { type: string; text: string }) => {
      const message = getInstallProgressMessage(data, data.text.trim())
      setSteamCmdStatus(message)
      if (installing_.current) log({ type: data.type === 'stderr' ? 'stderr' : 'stdout', message })
    }

    socket.on('install:log', onInstallLog)
    socket.on('install:complete', onInstallComplete)
    socket.on('steamcmd:status', onSteamCmdStatus)
    socket.on('steamcmd:log', onSteamCmdLog)
    return () => {
      socket.off('install:log', onInstallLog)
      socket.off('install:complete', onInstallComplete)
      socket.off('steamcmd:status', onSteamCmdStatus)
      socket.off('steamcmd:log', onSteamCmdLog)
    }
  }, [socket])

  const downloadSteamCmd = async () => {
    setDownloadingSteamCmd(true)
    setSteamCmdStatus('Starting the download…')
    try {
      await serverApi.downloadSteamCmd(steamCmdPath)
    } catch (error) {
      setDownloadingSteamCmd(false)
      toastManager.add({ title: "SteamCMD didn't download", description: getUserErrorMessage(error, 'Failed to start the SteamCMD download.'), type: 'error' })
    }
  }

  const confirmExistingSteamCmd = async () => {
    try {
      await configApi.updateAppSettings({ steamcmdPath: steamCmdPath })
      setHasSteamCmd(true)
    } catch {
      toastManager.add({ title: "Couldn't save the SteamCMD folder", type: 'error' })
    }
  }

  const install = async () => {
    if (settingsProblem) return
    setInstalling(true)
    installing_.current = true
    setLogs([{ type: 'info', message: 'Starting the installation…' }])
    setProgress(null)
    try {
      await serverApi.install({
        steamcmdPath: steamCmdPath,
        installPath: form.installPath,
        serverName: form.serverName,
        branch,
        zomboidDataPath: form.useCustomDataPath ? form.zomboidDataPath : null,
        minMemory: form.minMemory,
        maxMemory: form.maxMemory,
        adminPassword: form.adminPassword || null,
        serverPort: form.serverPort,
        useUpnp: form.useUpnp,
        useNoSteam: form.useNoSteam,
        useDebug: form.useDebug,
        rconPassword: form.rconPassword,
        rconPort: form.rconPort,
      })
      writeInstallInFlightMarker({ installPath: form.installPath, serverName: form.serverName, startedAt: Date.now() })
    } catch (error) {
      installing_.current = false
      const message = installationErrorGuidance(rawErrorMessageIntentional(error, 'Unknown error'), getUserErrorMessage(error, 'Unknown error'), runtimeInfo?.platform ?? null)
      log({ type: 'error', message })
      setInstalling(false)
      toastManager.add({ title: 'Installation failed', description: message, type: 'error' })
    }
  }

  const canProceed = [hasSteamCmd && steamCmdPath.length > 0, form.installPath.length > 0 && form.serverName.length > 0, !settingsProblem, true][step]
  const blocker = [
    !steamCmdPath.trim() ? 'Set a SteamCMD folder.' : 'Install or confirm SteamCMD.',
    !form.installPath.trim() ? 'Choose an install folder.' : 'Enter a server name.',
    settingsProblem,
    null,
  ][step]
  const branchItems = branches.map((b) => ({ value: b.name, label: b.name === 'public' ? 'Build 42 (stable)' : b.description || b.name }))

  return (
    <Wizard steps={['SteamCMD', 'Server', 'Settings', 'Install']} step={step} onStep={setStep} onExit={onExit} canProceed={canProceed} blocker={blocker} busy={installing || complete}>
      {step === 0 &&
        (hasSteamCmd ? (
          <Alert variant="success">
            <AlertTitle>SteamCMD is ready</AlertTitle>
            <AlertDescription className="flex-row flex-wrap items-center justify-between">
              <code className="font-mono break-all">{steamCmdPath}</code>
              <Button size="xs" variant="outline" onClick={() => setHasSteamCmd(false)}>
                Change folder
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <SettingsCard title="SteamCMD" description="Valve's command-line tool. The panel uses it to download and update the dedicated server.">
            <SettingsRow label="Folder" stacked description="Where SteamCMD lives, or where the panel should install it.">
              <PathInput value={steamCmdPath} onChange={setSteamCmdPath} browseTitle="Choose the SteamCMD folder" placeholder={runtimeInfo?.family === 'windows' ? 'C:\\SteamCMD' : '~/steamcmd'} disabled={downloadingSteamCmd} />
            </SettingsRow>
            <div className="flex flex-wrap items-center gap-2 py-4">
              <Button onClick={() => void downloadSteamCmd()} disabled={downloadingSteamCmd}>
                {downloadingSteamCmd ? <Loader2 className="animate-spin" /> : <Download />}
                {downloadingSteamCmd ? steamCmdStatus || 'Installing SteamCMD…' : 'Install SteamCMD for me'}
              </Button>
              <Button variant="outline" onClick={() => void confirmExistingSteamCmd()} disabled={downloadingSteamCmd || !steamCmdPath.trim()}>
                I already have it here
              </Button>
              <Button variant="ghost" render={<a href="https://developer.valvesoftware.com/wiki/SteamCMD#Downloading_SteamCMD" target="_blank" rel="noopener noreferrer" />}>
                <ExternalLink />
                Get SteamCMD from Valve
              </Button>
            </div>
          </SettingsCard>
        ))}

      {step === 1 && (
        <SettingsCard title="Server" description="Where the game files go and what the server is called.">
          <SettingsRow
            label="Install folder"
            stacked
            description={
              <>
                SteamCMD downloads about 3 GB here and creates the folder if needed. Saves and settings go in{' '}
                <code className="font-mono break-all">{form.installPath.trim() ? `${form.installPath.trim()}_Data` : 'your-install-folder_Data'}</code>. Both must be
                writable. With the bundled Linux service, use <code className="font-mono">{LINUX_SERVICE_INSTALL_PATH}</code>.
              </>
            }
          >
            <div className="grid w-full gap-2">
              <PathInput value={form.installPath} onChange={(value) => set('installPath', value)} browseTitle="Choose the install folder" placeholder={runtimeInfo?.family === 'windows' ? 'C:\\PZServer' : '/home/steam/pzserver'} />
              <Button variant="link" size="sm" className="justify-self-start px-0" onClick={() => set('installPath', LINUX_SERVICE_INSTALL_PATH)}>
                Use the Linux service folder
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow label="Server name" description="Letters, numbers and underscores. It names the config file (myserver.ini), so set it now; renaming later starts a new config.">
            <Input className="w-56 font-mono" value={form.serverName} maxLength={64} onChange={(e) => set('serverName', e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} />
          </SettingsRow>
          <SettingsRow label="Game version" description="Most people want stable. Other branches are older or experimental builds, and saves and mods may not carry across.">
            <Select items={branchItems} value={branch} onValueChange={(value) => setBranch(String(value))}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {branchItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </SettingsRow>
        </SettingsCard>
      )}

      {step === 2 && <ServerSettingsFields state={state} />}

      {step === 3 && (
        <div className="grid gap-4">
          <ReviewList
            rows={[
              ['Install folder', form.installPath],
              ['Server name', form.serverName],
              ['Game version', branch === 'public' ? 'Build 42 (stable)' : branch],
              ['Memory', `${form.minMemory}–${form.maxMemory} GB`],
              ['Game port', String(form.serverPort)],
              ['RCON port', String(form.rconPort)],
            ]}
          />
          <Alert>
            <AlertTitle>Open these ports to players</AlertTitle>
            <AlertDescription>
              UDP {form.serverPort} for game traffic and UDP {form.serverPort + 1} for direct connect, on your firewall and router.
            </AlertDescription>
          </Alert>
          {!complete && (
            <Button size="lg" onClick={() => void install()} disabled={installing || Boolean(settingsProblem)}>
              {installing ? <Loader2 className="animate-spin" /> : <Download />}
              {installing ? 'Installing… follow the log below' : 'Install the server'}
            </Button>
          )}
          {installing && progress && (
            <Progress value={progress.percent}>
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>{progress.status}</span>
                <span className="tabular-nums">
                  {progress.percent.toFixed(0)}% {progress.detail && `· ${progress.detail}`}
                </span>
              </div>
              <ProgressTrack>
                <ProgressIndicator />
              </ProgressTrack>
            </Progress>
          )}
          <SetupLog lines={logs} running={installing} />
          {complete && <SetupComplete title="Server installed" firstStart />}
        </div>
      )}
    </Wizard>
  )
}
