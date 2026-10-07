import { useContext, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { configApi, serverApi, serversApi, serversDetectApi, type ServerInstance, type UpdateStatus } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { getInstallProgressMessage } from '@/lib/installProgressMessage'
import { SocketContext } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toastManager } from '@/components/ui/toast'

export type SteamOperationType = 'update' | 'verify'

interface Branch {
  name: string
  description: string
  buildId?: string | null
  timeUpdated?: string | null
}

const DEFAULT_BRANCHES: Branch[] = [
  { name: 'public', description: 'Public (stable)' },
  { name: 'unstable', description: 'Unstable beta' },
]

export function isCustomLauncherPath(installPath: string | null | undefined): boolean {
  return !!installPath && /\.(bat|sh|exe)$/i.test(installPath)
}

/** The folder SteamCMD installs into. A custom launcher path points at a script inside it. */
export function getInstallFolder(installPath: string | undefined): string {
  if (!installPath) return ''
  if (!isCustomLauncherPath(installPath)) return installPath
  const lastSlash = Math.max(installPath.lastIndexOf('\\'), installPath.lastIndexOf('/'))
  return lastSlash > 0 ? installPath.substring(0, lastSlash) : installPath
}

const normalize = (value: string | undefined | null) => (value || '').trim().toLowerCase()

function branchLabel(name: string) {
  return name === 'public' ? 'Public (stable)' : name
}

/** Runs SteamCMD update or verify for one server, streaming its log over the socket. */
export function SteamOperationDialog({
  server,
  type,
  installedBranch,
  onClose,
}: {
  server: ServerInstance | null
  type: SteamOperationType
  installedBranch?: UpdateStatus['installed']['branch']
  onClose: () => void
}) {
  const socket = useContext(SocketContext)
  const confirm = useConfirm()
  const [steamcmdPath, setSteamcmdPath] = useState('')
  const [branch, setBranch] = useState('public')
  const [branches, setBranches] = useState<Branch[]>(DEFAULT_BRANCHES)
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [completed, setCompleted] = useState<'success' | 'error' | null>(null)
  const [stalled, setStalled] = useState(false)
  const [clearing, setClearing] = useState(false)
  const lastActivity = useRef(0)
  const logEnd = useRef<HTMLDivElement>(null)
  const installFolder = getInstallFolder(server?.installPath)

  // Reset and pick the starting branch whenever the dialog opens for a server.
  useEffect(() => {
    if (!server) return
    const pick = normalize(installedBranch) || normalize(server.branch)
    setBranch(!pick || pick === 'stable' ? 'public' : pick)
    setLogs([])
    setRunning(false)
    setStalled(false)
    setCompleted(null)
    configApi
      .getAppSettings()
      .then((data) => {
        if (data.settings?.steamcmdPath) setSteamcmdPath(String(data.settings.steamcmdPath))
      })
      .catch(() => {})
  }, [server, installedBranch])

  useEffect(() => {
    if (!server) return
    let cancelled = false
    const load = async () => {
      setLoadingBranches(true)
      try {
        const detection = await serverApi.detectSteamCmd()
        const path = detection.found && detection.path ? detection.path : steamcmdPath
        if (cancelled) return
        if (path) setSteamcmdPath((current) => current.trim() || path)
        const data = await serverApi.getBranches(path)
        if (cancelled || !Array.isArray(data.branches)) return
        const fetched = data.branches as Branch[]
        const have = new Set(fetched.map((b) => b.name))
        const extras: Branch[] = []
        for (const name of [normalize(installedBranch), normalize(server.branch)].filter(Boolean)) {
          if (have.has(name)) continue
          have.add(name)
          extras.push({
            name,
            description:
              name === 'unstable'
                ? 'Build 42 testing branch. Back up saves and expect mod incompatibilities.'
                : name === 'iwbums'
                  ? 'Experimental testing branch. Back up saves before switching.'
                  : 'Beta branch selected for this server.',
          })
        }
        setBranches([...fetched, ...extras])
        setBranch((current) => (have.has(current) ? current : normalize(installedBranch) || normalize(server.branch) || 'public'))
      } catch (error) {
        reportClientError('Failed to fetch branches.', error)
      } finally {
        if (!cancelled) setLoadingBranches(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // steamcmdPath is read once to seed detection; re-running on every keystroke would spam SteamCMD.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, installedBranch])

  useEffect(() => {
    if (!socket || !server) return
    type Progress = { progressCode?: string; params?: Record<string, string | number> }
    const onStart = (data: Progress & { message: string }) => {
      lastActivity.current = Date.now()
      setRunning(true)
      setStalled(false)
      setLogs([getInstallProgressMessage(data, data.message)])
    }
    const onLog = (data: Progress & { text: string }) => {
      lastActivity.current = Date.now()
      setStalled(false)
      setLogs((prev) => [...prev.slice(-200), getInstallProgressMessage(data, data.text)])
    }
    const onComplete = (data: Progress & { success: boolean; message: string }) => {
      const message = getInstallProgressMessage(data, data.message)
      setRunning(false)
      setStalled(false)
      setCompleted(data.success ? 'success' : 'error')
      setLogs((prev) => [...prev, '', `${data.success ? '✓' : '✗'} ${message}`])
      toastManager.add({ title: data.success ? 'SteamCMD finished' : 'SteamCMD failed', description: message, type: data.success ? 'success' : 'error' })
    }
    socket.on('steam:start', onStart)
    socket.on('steam:log', onLog)
    socket.on('steam:complete', onComplete)
    return () => {
      socket.off('steam:start', onStart)
      socket.off('steam:log', onLog)
      socket.off('steam:complete', onComplete)
    }
  }, [socket, server])

  useEffect(() => {
    if (!running) return
    const interval = setInterval(() => {
      if (Date.now() - lastActivity.current >= 3 * 60 * 1000) setStalled(true)
    }, 15_000)
    return () => clearInterval(interval)
  }, [running])

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [logs])

  const start = async () => {
    if (!server || !steamcmdPath.trim()) return
    if (!installFolder) {
      toastManager.add({ title: "This server has no install folder", type: 'error' })
      return
    }
    configApi.updateAppSettings({ steamcmdPath }).catch(() => {})
    setLogs([])
    setRunning(true)
    setStalled(false)
    setCompleted(null)
    lastActivity.current = Date.now()
    try {
      if (type === 'verify') await serversApi.steamVerify(steamcmdPath, installFolder, branch, server.id)
      else await serversApi.steamUpdate(steamcmdPath, installFolder, branch, server.id)
    } catch (error) {
      setRunning(false)
      toastManager.add({ title: "SteamCMD didn't start", description: getUserErrorMessage(error, 'Failed to start the operation.'), type: 'error' })
    }
  }

  const clearInstallFolder = async () => {
    if (!server) return
    const ok = await confirm({
      title: 'Clear the installation folder?',
      description: `This permanently deletes everything in ${installFolder}: game files, SteamCMD's download state and any mods installed there. Use it when SteamCMD updates keep failing. Run the update again afterwards to reinstall. Save data isn't affected.`,
      confirmLabel: 'Clear folder',
    })
    if (!ok) return
    setClearing(true)
    try {
      const result = (await serversDetectApi.deleteFiles(installFolder, server.id)) as { error?: string }
      if (result?.error) throw new Error(result.error)
      setLogs([])
      setCompleted(null)
      toastManager.add({ title: 'Installation folder cleared', description: 'Run the update to reinstall from scratch.' })
    } catch (error) {
      toastManager.add({ title: "Couldn't clear the folder", description: getUserErrorMessage(error, 'Failed to clear the installation folder.'), type: 'error' })
    } finally {
      setClearing(false)
    }
  }

  const selected = branches.find((b) => b.name === branch)
  const branchDetails = selected
    ? [selected.description, selected.buildId && `Build ${selected.buildId}`, selected.timeUpdated && `Updated ${new Date(selected.timeUpdated).toLocaleString('en')}`]
        .filter(Boolean)
        .join(' · ')
    : 'Choose the Steam branch to download from.'
  const branchItems = branches.map((b) => ({ value: b.name, label: branchLabel(b.name) }))

  return (
    <Dialog open={server !== null} onOpenChange={(open) => !open && (!running || stalled) && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{type === 'verify' ? 'Verify game files' : 'Update with SteamCMD'}</DialogTitle>
          <DialogDescription>
            {type === 'verify' ? 'Check and repair game files with SteamCMD.' : 'Download the game build for the branch you choose.'}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">SteamCMD folder</span>
            <Input value={steamcmdPath} onChange={(e) => setSteamcmdPath(e.target.value)} placeholder="Folder that contains steamcmd" className="font-mono" disabled={running} />
          </label>
          <div className="grid gap-1.5 text-sm">
            <span className="font-medium">Install folder</span>
            <code className="rounded-lg border bg-muted px-3 py-2 font-mono text-sm break-all">{installFolder || 'Not set'}</code>
          </div>
          <div className="grid gap-1.5 text-sm">
            <span className="flex items-center gap-1.5 font-medium">
              Steam branch
              {loadingBranches && <Loader2 className="size-3.5 animate-spin" />}
            </span>
            <Select items={branchItems} value={branch} onValueChange={(value) => setBranch(String(value))} disabled={running || loadingBranches}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {branches.map((b) => (
                  <SelectItem key={b.name} value={b.name}>
                    {branchLabel(b.name)}
                    {(b.name === normalize(installedBranch) || b.name === normalize(server?.branch)) && <span className="ms-2 text-muted-foreground">current</span>}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="text-muted-foreground">{branchDetails}</span>
          </div>
          {logs.length > 0 && (
            <div className="h-48 overflow-y-auto rounded-lg border bg-muted p-3 font-mono text-xs leading-relaxed">
              {logs.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              <div ref={logEnd} />
            </div>
          )}
          {stalled && (
            <Alert variant="error">
              <AlertTitle>No progress for three minutes</AlertTitle>
              <AlertDescription>SteamCMD may still be running. Check the server's status before trying again.</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <span className="text-sm text-muted-foreground">Updates keep failing? Clear the install folder and reinstall.</span>
            <Button variant="destructive-outline" size="sm" disabled={running || clearing || !installFolder} onClick={() => void clearInstallFolder()}>
              {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Clear install folder
            </Button>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={running && !stalled}>
            {stalled ? 'Close anyway' : running ? 'Running…' : completed ? 'Close' : 'Cancel'}
          </Button>
          {completed === 'success' ? (
            <Button onClick={onClose}>
              <CheckCircle2 />
              Done
            </Button>
          ) : (
            <Button onClick={() => void start()} disabled={running || !steamcmdPath.trim()}>
              {running ? <Loader2 className="animate-spin" /> : type === 'verify' ? <ShieldCheck /> : <RefreshCw />}
              {running ? 'Running…' : completed === 'error' ? 'Retry' : type === 'verify' ? 'Start verify' : 'Start update'}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
