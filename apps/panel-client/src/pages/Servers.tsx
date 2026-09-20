import {
  useState,
  useEffect,
  useContext,
  useRef,
  useCallback,
  useMemo,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Server,
  Plus,
  Trash2,
  Edit2,
  Check,
  Power,
  MoreVertical,
  Loader2,
  FolderOpen,
  Download,
  Search,
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
  Info,
  Globe,
  HardDrive,
  Database,
  ArrowRight,
  GitBranch,
  Cpu,
  Network,
  Play,
  Square,
  Container,
  RotateCw,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { reportClientError, reportClientWarning } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  serversApi,
  serversDetectApi,
  dockerApi,
  DockerContainerStats,
  DockerContainerSummary,
  ServerInstance,
  configApi,
  serverApi,
  updateApi,
  UpdateStatus,
  DiscoveredMount,
} from '@/lib/api'
import {
  resolveClientProvider,
  resolveServerCardRunning,
  waitForServerState,
} from '@/lib/serverStatus'
import { getInstallProgressMessage } from '@/lib/installProgressMessage'
import { ServerStatusBadge } from '@/components/ServerStatusBadge'
import { SocketContext } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useNavigate } from '@tanstack/react-router'
import { PageHeader } from '@/components/PageHeader'
import { PasswordInput } from '@/components/PasswordInput'
import { NumberInput } from '@/components/NumberInput'
import { RconTestConnection } from '@/components/RconTestConnection'
import { MountDiscoveryBanner } from '@/components/MountDiscoveryBanner'
import { DiscoverySetup } from '@/components/DiscoverySetup'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { panelQueryKeys } from '@/lib/queryClient'

interface DetectedServerConfig {
  dataPath: string
  serverConfigPath: string
  dockerContainerName: string
  serverName: string
  iniFile: string
  rconPort: number
  serverPort: number
  publicName: string
  hasRcon: boolean
  matchedBatFile?: string | null
  matchedInstallPath?: string | null
}

interface CustomBatFile {
  path: string
  folder: string
  fileName: string
  serverName: string
}

interface AutoScanResult {
  scanPath: string
  installPaths: string[]
  dataPaths: string[]
  customBatFiles: CustomBatFile[]
  detectedConfigs: DetectedServerConfig[]
}

interface DetectedServer {
  serverName: string
  iniFile: string
  rconPort: number
  serverPort: number
  publicName: string
  hasRcon: boolean
}

interface DetectResult {
  valid: boolean
  dataPath: string
  serverConfigPath: string
  installPath: string
  validInstallPath: boolean
  hasNoSteam: boolean
  detectedServers: DetectedServer[]
}

interface NewServerForm {
  name: string
  serverName: string
  installPath: string
  zomboidDataPath: string
  serverConfigPath: string
  dockerContainerName: string
  rconHost: string
  rconPort: number
  rconPassword: string
  serverPort: number
  minMemory: number
  maxMemory: number
  useNoSteam: boolean
  useDebug: boolean
}

const defaultNewServer: NewServerForm = {
  name: '',
  serverName: 'servertest',
  installPath: '',
  zomboidDataPath: '',
  serverConfigPath: '',
  dockerContainerName: '',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  )
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function isValidGamePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65534
}

export function isCustomLauncherPath(
  installPath: string | null | undefined,
): boolean {
  return !!installPath && /\.(bat|sh|exe)$/i.test(installPath)
}

export function isZomboidDataNestedInInstall(
  zomboidDataPath: string | null | undefined,
  installPath: string | null | undefined,
): boolean {
  if (!zomboidDataPath || !installPath) return false
  const normalize = (p: string) => p.replace(/[/\\]+$/, '').toLowerCase()
  const data = normalize(zomboidDataPath)
  const install = normalize(installPath)
  return (
    data === install ||
    data.startsWith(`${install}/`) ||
    data.startsWith(`${install}\\`)
  )
}

export function resolveDockerCardHostStatus(
  dockerAvailable: boolean,
  container: { state: string } | undefined,
): 'running' | 'stopped' | 'unknown' {
  if (!dockerAvailable || !container) return 'unknown'
  return container.state === 'running' ? 'running' : 'stopped'
}

export default function Servers() {
  const runtimeInfo = useRuntimeInfo()
  const confirm = useConfirm()
  const { toast } = useToast()
  const socket = useContext(SocketContext)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const {
    data: serversData,
    error: serversQueryError,
    isPending: serversPending,
    refetch: refetchServers,
  } = useQuery({
    queryKey: panelQueryKeys.servers,
    queryFn: () => serversApi.getAll(),
    retry: false,
    staleTime: 0,
  })
  const servers = serversData?.servers ?? null
  const managedLifecycleSupported =
    serversData?.lifecycleCapabilities?.supported === true
  const activeServerId = servers?.find((server) => server.isActive)?.id ?? null

  const { data: serverStatusData, refetch: refetchServerStatuses } = useQuery({
    queryKey: panelQueryKeys.serversStatus,
    queryFn: () => serversApi.getStatus({ retries: 0 }),
    retry: false,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })
  const serverStatuses = useMemo(() => {
    const next: Record<
      string,
      { running: boolean; pid: string | null; stateUnknown?: boolean }
    > = {}
    for (const server of serverStatusData?.servers || []) {
      next[String(server.id)] = {
        running: !!server.running,
        pid: server.pid,
        stateUnknown: server.stateUnknown === true,
      }
    }
    return next
  }, [serverStatusData])

  const { data: rconStatusData } = useQuery({
    queryKey: panelQueryKeys.rconStatuses,
    queryFn: () => serversApi.getRconStatuses(),
    retry: false,
    staleTime: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
  const rconStatuses = useMemo(
    () =>
      Object.fromEntries(
        (rconStatusData?.servers || []).map((server) => [
          String(server.id),
          server.status,
        ]),
      ),
    [rconStatusData],
  )

  const { data: dockerData, refetch: refetchDockerState } = useQuery({
    queryKey: panelQueryKeys.dockerStatus,
    queryFn: async () => {
      const status = await dockerApi.getStatus()
      if (!status.enabled || !status.available)
        return { ...status, stats: {} as Record<string, DockerContainerStats> }
      const stats = await dockerApi.getStats()
      return { ...status, stats: stats.containers || {} }
    },
    retry: false,
    staleTime: 0,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
  const dockerAvailable = Boolean(dockerData?.enabled && dockerData?.available)
  const dockerContainers = dockerData?.containers ?? []
  const dockerStats = dockerData?.stats ?? {}

  const { data: activeStatusData } = useQuery({
    queryKey: panelQueryKeys.activeServerStatusFor(activeServerId),
    queryFn: () => serversApi.getComposedStatus({ retries: 0 }),
    enabled: activeServerId !== null,
    retry: false,
    staleTime: 0,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
  const currentActiveStatus =
    activeServerId !== null ? (activeStatusData ?? null) : null

  const [fetchError, setFetchError] = useState<string | null>(null)
  const serversConfirmedEmpty = servers !== null && servers.length === 0
  const [dockerActionPending, setDockerActionPending] = useState<string | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (serversPending) return
    setLoading(false)
    if (serversQueryError) {
      reportClientError('Failed to fetch servers.', serversQueryError)
      setFetchError(
        getUserErrorMessage(
          serversQueryError,
          'Failed to load your servers. The backend may be unreachable.',
        ),
      )
    }
  }, [serversPending, serversQueryError])
  const [editingServer, setEditingServer] = useState<ServerInstance | null>(
    null,
  )
  const [savingEdit, setSavingEdit] = useState(false)
  const [lifecyclePending, setLifecyclePending] = useState(false)
  const [deleteServer, setDeleteServer] = useState<ServerInstance | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState(0)
  const deleteProgressRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const branchFetchIdRef = useRef(0)
  const [activating, setActivating] = useState<string | number | null>(null)

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newServer, setNewServer] = useState<NewServerForm>(defaultNewServer)
  const [addingServer, setAddingServer] = useState(false)

  const samePath = (a?: string | null, b?: string | null) =>
    !!a &&
    !!b &&
    a.replace(/[\\/]+$/, '').toLowerCase() ===
      b.replace(/[\\/]+$/, '').toLowerCase()

  const tandemConflicts = useMemo(() => {
    const others = servers || []
    if (others.length === 0) return []
    const found: Array<{ label: string; detail: string }> = []
    for (const other of others) {
      if (newServer.serverName && other.serverName === newServer.serverName) {
        found.push({
          label: 'Config name',
          detail:
            String(other.name) +
            ' already uses ' +
            String(other.serverName) +
            '.ini',
        })
      }
      if (
        Math.abs(Number(other.serverPort) - Number(newServer.serverPort)) <= 1
      ) {
        found.push({
          label: 'Game port',
          detail:
            String(other.name) +
            ' uses ' +
            String(other.serverPort) +
            ' and ' +
            String(Number(other.serverPort) + 1),
        })
      }
      if (Number(other.rconPort) === Number(newServer.rconPort)) {
        found.push({
          label: 'RCON port',
          detail: String(other.name) + ' uses ' + String(other.rconPort),
        })
      }
      if (samePath(other.zomboidDataPath, newServer.zomboidDataPath)) {
        found.push({
          label: 'Save folder',
          detail: String(other.name) + ' uses the same Zomboid data folder',
        })
      }
      if (samePath(other.installPath, newServer.installPath)) {
        found.push({
          label: 'Install folder',
          detail:
            'shared with ' +
            String(other.name) +
            ' — a SteamCMD update or a Workshop download will hit both',
        })
      }
    }
    return found
  }, [
    servers,
    newServer.serverName,
    newServer.serverPort,
    newServer.rconPort,
    newServer.zomboidDataPath,
    newServer.installPath,
  ])

  const [detecting, setDetecting] = useState(false)
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [selectedServerConfig, setSelectedServerConfig] = useState<string>('')
  const [importIniFrom, setImportIniFrom] = useState<{
    dataPath: string
    serverName: string
  } | null>(null)

  const [autoScanning, setAutoScanning] = useState(false)
  const [autoScanPath, setAutoScanPath] = useState('')
  const [autoScanResult, setAutoScanResult] = useState<AutoScanResult | null>(
    null,
  )
  const [showAutoScan, setShowAutoScan] = useState(false)

  const [steamOperation, setSteamOperation] = useState<{
    server: ServerInstance
    type: 'update' | 'verify'
    branch: string
  } | null>(null)
  const [steamLogs, setSteamLogs] = useState<string[]>([])
  const [steamRunning, setSteamRunning] = useState(false)
  const [steamCompleted, setSteamCompleted] = useState<
    'success' | 'error' | null
  >(null)
  const [steamStalled, setSteamStalled] = useState(false)
  const steamLastActivityRef = useRef(0)
  const [clearingInstall, setClearingInstall] = useState(false)
  const [confirmClearInstall, setConfirmClearInstall] = useState(false)
  const [steamcmdPath, setSteamcmdPath] = useState('')
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null)
  const [gameVersion, setGameVersion] = useState<string | null>(null)
  const [availableBranches, setAvailableBranches] = useState<
    Array<{
      name: string
      description: string
      buildId?: string | null
      timeUpdated?: string | null
    }>
  >([
    { name: 'public', description: 'Public (Stable)' },
    { name: 'unstable', description: 'Unstable beta' },
  ])
  const [loadingBranches, setLoadingBranches] = useState(false)

  const [discoveredMounts, setDiscoveredMounts] = useState<DiscoveredMount[]>(
    [],
  )
  const [scanningMounts, setScanningMounts] = useState(false)
  const [discoverySetupMount, setDiscoverySetupMount] =
    useState<DiscoveredMount | null>(null)
  const connectableMounts = discoveredMounts.filter(
    (mount) => mount.dataPath && mount.serverNames.length > 0,
  )
  const fetchServers = useCallback(async () => {
    setFetchError(null)
    try {
      const result = await refetchServers()
      if (result.error) throw result.error
    } catch (error) {
      reportClientError('Failed to fetch servers.', error)
      setFetchError(
        getUserErrorMessage(
          error,
          'Failed to load your servers. The backend may be unreachable.',
        ),
      )
    } finally {
      setLoading(false)
    }
  }, [refetchServers])

  const fetchServerStatuses = useCallback(async () => {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    )
      return
    const result = await refetchServerStatuses()
    if (result.error)
      reportClientWarning('Failed to fetch per-server status.', result.error)
  }, [refetchServerStatuses])

  const fetchDockerState = useCallback(async () => {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    )
      return
    const result = await refetchDockerState()
    if (result.error)
      reportClientWarning('Failed to fetch managed Docker state.', result.error)
  }, [refetchDockerState])

  const handleDockerAction = useCallback(
    async (
      container: DockerContainerSummary,
      action: 'start' | 'stop' | 'restart',
    ) => {
      setDockerActionPending(`${action}-${container.id}`)
      try {
        const server = servers?.find(
          (item) =>
            item.dockerContainerName === container.name ||
            item.dockerContainerName === container.id,
        )
        if (!server) throw new Error('No server profile maps to this container')
        const result = await dockerApi.runAction(
          server.dockerContainerName || container.id,
          action,
          server.id,
        )
        if (!result.success)
          throw new Error(result.error || `Failed to ${action} container`)
        const actionLabel = action
        toast({
          title: 'Container ' + String(actionLabel) + ' requested',
          description: container.name,
          variant: 'success' as const,
        })
        await fetchDockerState()
      } catch (error) {
        const actionLabel = action
        toast({
          title: 'Container ' + String(actionLabel) + ' failed',
          description: getUserErrorMessage(error, 'Docker action failed'),
          variant: 'destructive',
        })
      } finally {
        setDockerActionPending(null)
      }
    },
    [fetchDockerState, servers, toast],
  )

  useEffect(() => {
    configApi
      .getAppSettings()
      .then((data) => {
        if (data.settings?.steamcmdPath) {
          setSteamcmdPath(data.settings.steamcmdPath)
        }
      })
      .catch((e) => reportClientWarning('Failed to load settings.', e))
    updateApi
      .getStatus()
      .then((status) => {
        if (status.updateAvailable?.updateAvailable) {
          setUpdateInfo(status.updateAvailable)
        }
        if (status.gameVersion) {
          setGameVersion(status.gameVersion)
        }
      })
      .catch((e) => reportClientWarning('Failed to load update status.', e))
  }, [])

  useEffect(() => {
    if (!socket) return

    const handleServerStatus = () => {
      void queryClient.invalidateQueries({
        queryKey: panelQueryKeys.serversStatus,
      })
      void queryClient.invalidateQueries({
        queryKey: panelQueryKeys.activeServerStatus,
      })
      void queryClient.invalidateQueries({
        queryKey: panelQueryKeys.rconStatuses,
      })
    }

    socket.on('server:status', handleServerStatus)
    return () => {
      socket.off('server:status', handleServerStatus)
    }
  }, [socket, queryClient])

  useEffect(() => {
    serversApi
      .discoverMounts()
      .then((data) => setDiscoveredMounts(data.mounts || []))
      .catch((e) => reportClientWarning('Mount discovery failed.', e))
  }, [])

  const handleScanMounts = async () => {
    setScanningMounts(true)
    try {
      const data = await serversApi.discoverMounts()
      const mounts = data.mounts || []
      const connectableCount = mounts.filter(
        (mount) => mount.dataPath && mount.serverNames.length > 0,
      ).length
      setDiscoveredMounts(mounts)
      toast({
        title: connectableCount
          ? Number(connectableCount) === 1
            ? String(connectableCount) + ' server found'
            : String(connectableCount) + ' servers found'
          : 'No servers found',
      })
    } catch (error) {
      toast({
        title: 'Scan Failed',
        description: getUserErrorMessage(error, 'Mount discovery failed'),
        variant: 'destructive',
      })
    } finally {
      setScanningMounts(false)
    }
  }

  useEffect(() => {
    if (!socket) return

    const handleUpdateAvailable = (data: UpdateStatus) => {
      setUpdateInfo(data.updateAvailable ? data : null)
    }
    const handleUpdateCheck = (data: UpdateStatus) => {
      setUpdateInfo(data.updateAvailable ? data : null)
    }

    socket.on('server:updateAvailable', handleUpdateAvailable)
    socket.on('server:updateCheck', handleUpdateCheck)
    return () => {
      socket.off('server:updateAvailable', handleUpdateAvailable)
      socket.off('server:updateCheck', handleUpdateCheck)
    }
  }, [socket])

  useEffect(() => {
    if (!steamOperation) return

    const thisFetchId = ++branchFetchIdRef.current

    const fetchBranches = async () => {
      setLoadingBranches(true)
      try {
        const detection = await serverApi.detectSteamCmd()
        if (thisFetchId !== branchFetchIdRef.current) return
        const resolvedSteamcmdPath =
          detection.found && detection.path ? detection.path : steamcmdPath
        if (resolvedSteamcmdPath) {
          setSteamcmdPath(
            (currentPath) => currentPath.trim() || resolvedSteamcmdPath,
          )
        }
        const data = await serverApi.getBranches(resolvedSteamcmdPath)
        if (thisFetchId !== branchFetchIdRef.current) return
        if (data.branches && Array.isArray(data.branches)) {
          setAvailableBranches(() => {
            const fetched = data.branches as Array<{
              name: string
              description: string
              buildId?: string | null
            }>
            const extras: typeof fetched = []
            const have = new Set(fetched.map((b) => b.name))
            const normalize = (v: string | undefined | null) =>
              (v || '').trim().toLowerCase()
            const candidates = [
              normalize(updateInfo?.installed?.branch),
              normalize(steamOperation?.server.branch),
              normalize(steamOperation?.branch),
            ].filter(Boolean) as string[]
            for (const name of candidates) {
              if (!have.has(name)) {
                const description =
                  name === 'unstable'
                    ? 'Build 42 testing branch. Back up saves and expect mod incompatibilities.'
                    : name === 'iwbums'
                      ? 'Experimental testing branch. Back up saves before switching.'
                      : 'Beta branch selected for this server.'
                extras.push({ name, description })
                have.add(name)
              }
            }
            return [...fetched, ...extras]
          })
          setSteamOperation((prev) => {
            if (!prev) return prev
            const names = new Set(
              data.branches.map((b: { name: string }) => b.name),
            )
            const installed = (updateInfo?.installed?.branch || '')
              .trim()
              .toLowerCase()
            const serverBranch = (prev.server.branch || '').trim().toLowerCase()
            if (prev.branch === installed) return prev
            if (prev.branch === serverBranch) return prev
            if (names.has(prev.branch)) return prev
            const fallback =
              installed ||
              serverBranch ||
              (names.has('public') ? 'public' : data.branches[0]?.name)
            return fallback ? { ...prev, branch: fallback } : prev
          })
        }
      } catch (error) {
        reportClientError('Failed to fetch branches.', error)
        // Keep default branches on error
      } finally {
        if (thisFetchId === branchFetchIdRef.current) setLoadingBranches(false)
      }
    }

    fetchBranches()
  }, [steamOperation, steamcmdPath, updateInfo?.installed?.branch])

  useEffect(() => {
    if (!socket) return

    const handleActiveServerChanged = () => {
      void queryClient.invalidateQueries({ queryKey: panelQueryKeys.servers })
      void queryClient.invalidateQueries({
        queryKey: panelQueryKeys.activeServer,
      })
      void queryClient.invalidateQueries({
        queryKey: panelQueryKeys.serverStatus,
      })
      void queryClient.invalidateQueries({
        queryKey: panelQueryKeys.activeServerStatus,
      })
      void queryClient.invalidateQueries({
        queryKey: panelQueryKeys.rconStatuses,
      })
    }

    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, queryClient])

  useEffect(() => {
    if (!socket) return

    const handleSteamStart = (data: {
      type: string
      message: string
      progressCode?: string
      params?: Record<string, string | number>
    }) => {
      steamLastActivityRef.current = Date.now()
      setSteamRunning(true)
      setSteamStalled(false)
      setSteamLogs([getInstallProgressMessage(data, data.message)])
    }

    const handleSteamLog = (data: {
      type: string
      text: string
      progressCode?: string
      params?: Record<string, string | number>
    }) => {
      steamLastActivityRef.current = Date.now()
      setSteamStalled(false)
      setSteamLogs((prev) => [
        ...prev.slice(-200),
        getInstallProgressMessage(data, data.text),
      ])
    }

    const handleSteamComplete = (data: {
      success: boolean
      message: string
      progressCode?: string
      params?: Record<string, string | number>
    }) => {
      const displayMessage = getInstallProgressMessage(data, data.message)
      setSteamRunning(false)
      setSteamStalled(false)
      setSteamCompleted(data.success ? 'success' : 'error')
      setSteamLogs((prev) => [
        ...prev,
        '',
        data.success ? '✓ ' + displayMessage : '✗ ' + displayMessage,
      ])
      toast({
        title: data.success ? 'Success' : 'Failed',
        description: displayMessage,
        variant: data.success ? 'default' : 'destructive',
      })
    }

    socket.on('steam:start', handleSteamStart)
    socket.on('steam:log', handleSteamLog)
    socket.on('steam:complete', handleSteamComplete)

    return () => {
      socket.off('steam:start', handleSteamStart)
      socket.off('steam:log', handleSteamLog)
      socket.off('steam:complete', handleSteamComplete)
    }
  }, [socket, toast])

  useEffect(() => {
    if (!steamRunning) return
    const interval = setInterval(() => {
      if (Date.now() - steamLastActivityRef.current >= 3 * 60 * 1000) {
        setSteamStalled(true)
      }
    }, 15_000)
    return () => clearInterval(interval)
  }, [steamRunning])

  const handleDetectServer = async () => {
    if (!newServer.zomboidDataPath.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter the server data path first',
        variant: 'destructive',
      })
      return
    }

    setDetecting(true)
    setDetectError(null)
    setDetectResult(null)
    setSelectedServerConfig('')
    setImportIniFrom(null)

    try {
      const data = (await serversDetectApi.detect({
        dataPath: newServer.zomboidDataPath,
        installPath: newServer.installPath || undefined,
      })) as unknown as DetectResult & { error?: string }

      if (!data || data.error) {
        setDetectError(data?.error || 'Detection failed')
        return
      }

      setDetectResult(data)

      if (data.detectedServers.length === 1) {
        handleSelectServerConfig(data.detectedServers[0], data)
      } else if (data.detectedServers.length > 1) {
        toast({
          title: 'Multiple Servers Found',
          description: 'Please select which server configuration to use',
        })
      }

      if (data.hasNoSteam) {
        setNewServer((prev) => ({ ...prev, useNoSteam: true }))
      }
    } catch (error) {
      setDetectError(getUserErrorMessage(error, 'Detection failed'))
    } finally {
      setDetecting(false)
    }
  }

  const handleAutoScan = async () => {
    if (!autoScanPath.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a folder path to scan',
        variant: 'destructive',
      })
      return
    }

    setAutoScanning(true)
    setAutoScanResult(null)

    try {
      const data = (await serversDetectApi.autoScan({
        scanPath: autoScanPath,
        maxDepth: 4,
      })) as unknown as AutoScanResult & { error?: string }

      if (!data || data.error) {
        toast({
          title: 'Scan Failed',
          description: data.error || 'Unknown error',
          variant: 'destructive',
        })
        return
      }

      setAutoScanResult(data)

      if (data.detectedConfigs.length === 0) {
        toast({
          title: 'No servers found',
          description:
            'No Project Zomboid servers were found in the scanned folder',
        })
      } else {
        toast({
          title: 'Servers found!',
          description:
            'Found ' +
            String(data.detectedConfigs.length) +
            ' server configuration(s)',
        })
      }
    } catch (error) {
      toast({
        title: 'Scan Failed',
        description: getUserErrorMessage(error, 'Auto-scan failed'),
        variant: 'destructive',
      })
    } finally {
      setAutoScanning(false)
    }
  }

  const handleSelectScannedConfig = (
    config: DetectedServerConfig,
    installPath?: string,
  ) => {
    const effectiveInstallPath = config.matchedBatFile || installPath || ''

    setNewServer({
      ...defaultNewServer,
      name: config.publicName || config.serverName,
      serverName: config.serverName,
      zomboidDataPath: config.dataPath,
      installPath: effectiveInstallPath,
      rconPort: config.rconPort,
      serverPort: config.serverPort,
    })
    setSelectedServerConfig(config.serverName)
    setImportIniFrom(
      config.hasRcon
        ? { dataPath: config.dataPath, serverName: config.serverName }
        : null,
    )
    setShowAutoScan(false)

    setDetectResult({
      valid: true,
      dataPath: config.dataPath,
      serverConfigPath: config.serverConfigPath,
      installPath: effectiveInstallPath,
      validInstallPath: !!effectiveInstallPath,
      hasNoSteam: false,
      detectedServers: [
        {
          serverName: config.serverName,
          iniFile: config.iniFile,
          rconPort: config.rconPort,
          serverPort: config.serverPort,
          publicName: config.publicName,
          hasRcon: config.hasRcon,
        },
      ],
    })

    if (!config.hasRcon) {
      toast({
        title: 'RCON not configured',
        description:
          "This server has no RCON password set. You'll need to configure it in the server INI file.",
        variant: 'destructive',
      })
    }
  }

  const handleSelectServerConfig = (
    config: DetectedServer,
    result?: DetectResult,
  ) => {
    const res = result || detectResult
    setSelectedServerConfig(config.serverName)
    setNewServer((prev) => ({
      ...prev,
      name: config.publicName || config.serverName,
      serverName: config.serverName,
      zomboidDataPath: res?.dataPath || prev.zomboidDataPath,
      serverConfigPath: res?.serverConfigPath || prev.serverConfigPath,
      rconPort: config.rconPort,
      rconPassword: '',
      serverPort: config.serverPort,
    }))
    setImportIniFrom(
      config.hasRcon && res?.dataPath
        ? { dataPath: res.dataPath, serverName: config.serverName }
        : null,
    )

    if (!config.hasRcon) {
      toast({
        title: 'RCON not configured',
        description:
          "This server has no RCON password set. You'll need to configure it in the server INI file.",
        variant: 'destructive',
      })
    }
  }

  const handleActivateServer = useCallback(
    async (server: ServerInstance) => {
      if (server.isActive) return

      setActivating(server.id)
      try {
        await serversApi.activate(server.id)
        toast({
          title: 'Server Activated',
          description: 'Now managing: ' + String(server.name),
        })
        fetchServers()
      } catch (error) {
        toast({
          title: 'Error',
          description: getUserErrorMessage(error, 'Failed to activate server'),
          variant: 'destructive',
        })
      } finally {
        setActivating(null)
      }
    },
    [toast, fetchServers],
  )

  const [serverActionPending, setServerActionPending] = useState<string | null>(
    null,
  )
  const waitForActionState = useCallback(
    async (serverId: string | number, expectedRunning: boolean) => {
      return waitForServerState(
        () => serversApi.getStatus({ retries: 0 }),
        serverId,
        expectedRunning,
        (serverStatus) => {
          queryClient.setQueryData(panelQueryKeys.serversStatus, (previous) => {
            if (
              !previous ||
              typeof previous !== 'object' ||
              !('servers' in previous) ||
              !Array.isArray(previous.servers)
            )
              return previous
            return {
              ...previous,
              servers: previous.servers.map((entry) =>
                String(entry.id) === String(serverStatus.id)
                  ? {
                      ...entry,
                      running: serverStatus.running,
                      pid: serverStatus.pid,
                    }
                  : entry,
              ),
            }
          })
        },
      )
    },
    [queryClient],
  )

  const handleInlineStart = useCallback(
    async (server: ServerInstance) => {
      setServerActionPending(`start-${server.id}`)
      try {
        if (!server.isActive) {
          await serversApi.activate(server.id)
        }
        await serverApi.start()
        const confirmed = await waitForActionState(server.id, true)
        toast({
          title: confirmed ? 'Server Started' : 'Server Start Requested',
          description: confirmed
            ? server.name || server.serverName
            : 'The panel is still waiting for the process to appear.',
          variant: confirmed ? ('success' as const) : 'default',
        })
        await Promise.allSettled([fetchServers(), fetchServerStatuses()])
      } catch (error) {
        toast({
          title: 'Failed to start server',
          description: getUserErrorMessage(error, 'Unknown error'),
          variant: 'destructive',
        })
      } finally {
        setServerActionPending(null)
      }
    },
    [toast, fetchServers, fetchServerStatuses, waitForActionState],
  )

  const handleInlineStop = useCallback(
    async (server: ServerInstance) => {
      const ok = await confirm({
        title: 'Stop server?',
        description:
          'This will disconnect all connected players. You can start it again anytime.',
        confirmLabel: 'Stop',
        destructive: false,
      })
      if (!ok) return
      setServerActionPending(`stop-${server.id}`)
      try {
        if (!server.isActive) {
          await serversApi.activate(server.id)
        }
        await serverApi.stop()
        const confirmed = await waitForActionState(server.id, false)
        toast({
          title: confirmed ? 'Server Stopped' : 'Server Stop Requested',
          description: confirmed
            ? server.name || server.serverName
            : 'The panel is still waiting for the process to stop.',
          variant: confirmed ? ('success' as const) : 'default',
        })
        await Promise.allSettled([fetchServers(), fetchServerStatuses()])
      } catch (error) {
        toast({
          title: 'Failed to stop server',
          description: getUserErrorMessage(error, 'Unknown error'),
          variant: 'destructive',
        })
      } finally {
        setServerActionPending(null)
      }
    },
    [toast, fetchServers, fetchServerStatuses, waitForActionState, confirm],
  )

  const handleDeleteServer = async () => {
    if (!deleteServer) return

    setDeleting(true)
    setDeleteProgress(0)

    let prog = 0
    deleteProgressRef.current = setInterval(() => {
      prog += prog < 70 ? 8 : 1
      if (prog > 92) prog = 92
      setDeleteProgress(prog)
    }, 200)

    let filesActuallyDeleted = false

    try {
      if (deleteFiles && deleteServer.installPath) {
        try {
          const result = (await serversDetectApi.deleteFiles(
            deleteServer.installPath,
          )) as { error?: string }
          if (result?.error) {
            toast({
              title: 'File deletion failed',
              description: result.error,
              variant: 'destructive',
            })
          } else {
            filesActuallyDeleted = true
          }
        } catch (e) {
          const msg = getUserErrorMessage(e, 'Could not delete server files')
          toast({
            title: 'Warning',
            description: String(msg) + ' — removing from panel anyway.',
            variant: 'destructive',
          })
        }
      }

      await serversApi.delete(deleteServer.id)

      if (deleteProgressRef.current) clearInterval(deleteProgressRef.current)
      setDeleteProgress(100)
      await new Promise((r) => setTimeout(r, 350))

      toast({
        title: 'Deleted',
        description: filesActuallyDeleted
          ? 'Server "' +
            String(deleteServer.name) +
            '" and its files have been deleted'
          : 'Server "' + String(deleteServer.name) + '" removed from panel',
      })
      setDeleteServer(null)
      setDeleteFiles(false)
      fetchServers()
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to delete server'),
        variant: 'destructive',
      })
    } finally {
      if (deleteProgressRef.current) clearInterval(deleteProgressRef.current)
      setDeleting(false)
      setDeleteProgress(0)
    }
  }

  const handleSaveEdit = async () => {
    if (!editingServer || savingEdit) return

    const storedLifecycleProvider =
      servers?.find((server) => server.id === editingServer.id)
        ?.lifecycleProvider || 'direct'
    if (
      (editingServer.lifecycleProvider || 'direct') !== storedLifecycleProvider
    ) {
      toast({
        title: 'Warning',
        description:
          'Activate the selected lifecycle provider or switch back to the current provider before saving other server settings.',
        variant: 'destructive',
      })
      return
    }

    if (!isValidPort(editingServer.rconPort)) {
      toast({
        title: 'Error',
        description: 'RCON port must be between 1 and 65535',
        variant: 'destructive',
      })
      return
    }
    if (!isValidGamePort(editingServer.serverPort)) {
      toast({
        title: 'Error',
        description: 'Game port must be between 1 and 65534',
        variant: 'destructive',
      })
      return
    }
    if (
      !Number.isFinite(editingServer.minMemory) ||
      !Number.isFinite(editingServer.maxMemory)
    ) {
      toast({
        title: 'Error',
        description: 'Enter a minimum and maximum memory value',
        variant: 'destructive',
      })
      return
    }

    if (
      editingServer.startCommand &&
      /[&|;<>`${}()!\[\]]/.test(editingServer.startCommand)
    ) {
      toast({
        title: 'Error',
        description: 'Command contains disallowed shell characters',
        variant: 'destructive',
      })
      return
    }

    setSavingEdit(true)
    try {
      const result = await serversApi.update(editingServer.id, editingServer)
      const warnings = result.warnings?.filter(Boolean) ?? []
      toast({
        title: warnings.length > 0 ? 'Warning' : 'Saved',
        description:
          warnings.length > 0
            ? `${'Server settings updated'}. ${warnings.join(' ')}`
            : 'Server settings updated',
      })
      setEditingServer(null)
      fetchServers()
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to update server'),
        variant: 'destructive',
      })
    } finally {
      setSavingEdit(false)
    }
  }

  const handleDownloadLifecycleTemplate = async (server: ServerInstance) => {
    const provider = server.lifecycleProvider || 'direct'
    if (provider === 'direct' || lifecyclePending) return
    setLifecyclePending(true)
    try {
      const template = await serversApi.getLifecycleTemplate(
        server.id,
        provider,
      )
      const blob = new Blob([template.content], {
        type: 'text/plain;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = template.filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      toast({
        title: 'Service file generated',
        description:
          'Review the file and install it at ' +
          String(template.installPath) +
          ' as an administrator.',
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(
          error,
          'Could not generate the service file',
        ),
        variant: 'destructive',
      })
    } finally {
      setLifecyclePending(false)
    }
  }

  const handleActivateLifecycleProvider = async (server: ServerInstance) => {
    const provider = server.lifecycleProvider || 'direct'
    const stored = servers?.find((candidate) => candidate.id === server.id)
    const currentProvider = stored?.lifecycleProvider || 'direct'
    if (provider === currentProvider || lifecyclePending) return

    const accepted = await confirm({
      title: 'Change lifecycle ownership?',
      description:
        'Change this server from ' +
        String(currentProvider) +
        ' to ' +
        String(provider) +
        '? The backend will refuse if a process is running, the service is missing, or its ownership marker conflicts.',
      confirmLabel: 'Activate Provider',
      destructive: false,
      variant: 'warning',
    })
    if (!accepted) return

    setLifecyclePending(true)
    try {
      const result = await serversApi.activateLifecycleProvider(
        server.id,
        provider,
      )
      setEditingServer(result.server)
      await fetchServers()
      toast({
        title: 'Lifecycle provider activated',
        description: result.message,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(
          error,
          'Could not activate the lifecycle provider',
        ),
        variant: 'destructive',
      })
    } finally {
      setLifecyclePending(false)
    }
  }

  const handleStartSteamOperation = async () => {
    if (!steamOperation || !steamcmdPath.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter the SteamCMD path',
        variant: 'destructive',
      })
      return
    }

    const installFolder = getInstallFolder(steamOperation.server.installPath)
    if (!installFolder) {
      toast({
        title: 'Error',
        description: 'Server install path not configured',
        variant: 'destructive',
      })
      return
    }

    try {
      await configApi.updateAppSettings({ steamcmdPath })
    } catch (e) {
      // Non-critical, continue anyway
    }

    setSteamLogs([])
    setSteamRunning(true)
    setSteamStalled(false)
    steamLastActivityRef.current = Date.now()
    setSteamCompleted(null)

    try {
      if (steamOperation.type === 'verify') {
        await serversApi.steamVerify(
          steamcmdPath,
          installFolder,
          steamOperation.branch,
        )
      } else {
        await serversApi.steamUpdate(
          steamcmdPath,
          installFolder,
          steamOperation.branch,
        )
      }
    } catch (error) {
      setSteamRunning(false)
      setSteamStalled(false)
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to start operation'),
        variant: 'destructive',
      })
    }
  }

  const handleClearInstallFolder = async () => {
    if (!steamOperation) return
    const installFolder = getInstallFolder(steamOperation.server.installPath)
    if (!installFolder) {
      toast({
        title: 'Error',
        description: 'Server install path not configured',
        variant: 'destructive',
      })
      return
    }

    setClearingInstall(true)
    try {
      const result = (await serversDetectApi.deleteFiles(installFolder)) as {
        error?: string
      }
      if (result?.error) {
        toast({
          title: 'Could Not Clear Folder',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      setSteamLogs([])
      setSteamCompleted(null)
      toast({
        title: 'Installation Folder Cleared',
        description:
          'The folder was wiped. Click Start Update to reinstall from scratch.',
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(
          error,
          'Failed to clear installation folder',
        ),
        variant: 'destructive',
      })
    } finally {
      setClearingInstall(false)
      setConfirmClearInstall(false)
    }
  }

  const openSteamOperation = async (
    server: ServerInstance,
    type: 'update' | 'verify',
  ) => {
    const normalize = (v: string | undefined | null) =>
      (v || '').trim().toLowerCase()
    const installed = normalize(updateInfo?.installed?.branch)
    const stored = normalize(server.branch)
    const pick = installed || stored
    const initialBranch = !pick || pick === 'stable' ? 'public' : pick
    setSteamOperation({ server, type, branch: initialBranch })
    setSteamLogs([])
    setSteamRunning(false)
    setSteamStalled(false)
    setSteamCompleted(null)

    if (!steamcmdPath) {
      try {
        const data = await configApi.getAppSettings()
        if (data.settings?.steamcmdPath) {
          setSteamcmdPath(data.settings.steamcmdPath)
        }
      } catch (e) {
        // Ignore - user can enter manually
      }
    }
  }

  const getInstallFolder = (installPath: string | undefined): string => {
    if (!installPath) return ''
    if (isCustomLauncherPath(installPath)) {
      const lastSlash = Math.max(
        installPath.lastIndexOf('\\'),
        installPath.lastIndexOf('/'),
      )
      return lastSlash > 0 ? installPath.substring(0, lastSlash) : installPath
    }
    return installPath
  }

  const handleAddExistingServer = async () => {
    if (!selectedServerConfig) {
      toast({
        title: 'Error',
        description: 'Please detect a server first',
        variant: 'destructive',
      })
      return
    }
    if (!newServer.rconPassword.trim() && !importIniFrom) {
      toast({
        title: 'Error',
        description:
          'RCON password is required. Configure it in your server INI file first.',
        variant: 'destructive',
      })
      return
    }

    if (!isValidPort(newServer.rconPort)) {
      toast({
        title: 'Error',
        description: 'RCON port must be between 1 and 65535',
        variant: 'destructive',
      })
      return
    }
    if (!isValidGamePort(newServer.serverPort)) {
      toast({
        title: 'Error',
        description: 'Game port must be between 1 and 65534',
        variant: 'destructive',
      })
      return
    }
    if (
      !Number.isFinite(newServer.minMemory) ||
      !Number.isFinite(newServer.maxMemory)
    ) {
      toast({
        title: 'Error',
        description: 'Enter a minimum and maximum memory value',
        variant: 'destructive',
      })
      return
    }

    setAddingServer(true)
    try {
      const useIniImport = !!importIniFrom && !newServer.rconPassword.trim()

      const createResult = await serversApi.create({
        name: newServer.name || newServer.serverName,
        serverName: newServer.serverName,
        installPath: newServer.installPath,
        zomboidDataPath: newServer.zomboidDataPath,
        serverConfigPath: newServer.serverConfigPath,
        rconHost: newServer.rconHost,
        rconPort: newServer.rconPort,
        ...(useIniImport
          ? { importIniFrom }
          : { rconPassword: newServer.rconPassword }),
        dockerContainerName: newServer.dockerContainerName || null,
        serverPort: newServer.serverPort,
        minMemory: newServer.minMemory,
        maxMemory: newServer.maxMemory,
        useNoSteam: newServer.useNoSteam,
        useDebug: newServer.useDebug,
      } as Partial<ServerInstance> & {
        importIniFrom?: { dataPath: string; serverName: string }
      })

      if (createResult.server?.id) {
        await serversApi.activate(createResult.server.id)
      }

      toast({
        title: 'Server Added',
        description: '"' + String(newServer.name) + '" added to panel',
      })
      setShowAddDialog(false)
      setNewServer(defaultNewServer)
      setDetectResult(null)
      setDetectError(null)
      setSelectedServerConfig('')
      setImportIniFrom(null)
      fetchServers()
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to add server'),
        variant: 'destructive',
      })
    } finally {
      setAddingServer(false)
    }
  }

  const resetAddDialog = () => {
    setShowAddDialog(false)
    setNewServer(defaultNewServer)
    setDetectResult(null)
    setDetectError(null)
    setSelectedServerConfig('')
    setImportIniFrom(null)
    setAutoScanResult(null)
    setAutoScanPath('')
    setShowAutoScan(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={'Managed Servers'}
        description={'Manage multiple Project Zomboid servers from one panel'}
        eyebrow={'Fleet'}
        tone="servers"
        icon={<Server className="w-5 h-5 text-primary" />}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={handleScanMounts}
              disabled={scanningMounts}
              aria-label={'Scan for servers'}
              // eslint-disable-next-line local/no-dead-disabled-title -- This title describes the action, not why it is disabled.
              title={'Scan for servers'}
            >
              {scanningMounts ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>

            <Button variant="outline" onClick={() => setShowAddDialog(true)}>
              <FolderOpen className="w-4 h-4 me-2" /> {'Add Existing Server'}
            </Button>
            <Button
              variant="command"
              onClick={() => void navigate({ to: '/server-setup' })}
            >
              <Download className="w-4 h-4 me-2" /> {'Install New Server'}
            </Button>
          </div>
        }
      />

      {fetchError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{'Servers could not be loaded'}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 break-words" dir="auto">
              {fetchError}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchServers}
              className="self-start"
            >
              <RefreshCw className="me-2 h-4 w-4" /> {'Retry'}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {serversConfirmedEmpty && connectableMounts.length > 0 && (
        <div className="space-y-2">
          {connectableMounts.map((mount) => (
            <MountDiscoveryBanner
              key={mount.installPath}
              mount={mount}
              onConnect={setDiscoverySetupMount}
            />
          ))}
        </div>
      )}

      {serversConfirmedEmpty ? (
        <Card className="mission-brief overflow-hidden border-primary/20 bg-card">
          <CardContent className="py-10">
            <div className="mx-auto max-w-4xl space-y-8">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
                  <Server className="h-7 w-7" />
                </div>
                <h3 className="text-xl font-semibold text-foreground">
                  {'No Servers Configured'}
                </h3>
                <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {
                    'Start with one server. After it is active, dashboard, players, backups, mods, and remote actions come online.'
                  }
                </p>
              </div>

              <div className="mission-step-grid grid gap-4 md:grid-cols-3">
                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <FolderOpen className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">
                    {'Add an existing local server'}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {
                      'Use this when server files already exist on this machine.'
                    }
                  </p>
                  <Button
                    variant="outline"
                    className="onboarding-cta mt-4 w-full"
                    onClick={() => setShowAddDialog(true)}
                  >
                    <FolderOpen className="me-2 h-4 w-4" />
                    {'Add Existing Server'}
                  </Button>
                </div>

                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <Download className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">
                    {'Install a new local server'}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {
                      'Use the installer when you need files, ports, passwords, and memory setup in one flow.'
                    }
                  </p>
                  <Button
                    className="onboarding-cta mt-4 w-full"
                    onClick={() => void navigate({ to: '/server-setup' })}
                  >
                    <Download className="me-2 h-4 w-4" />
                    {'Install New Server'}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 rounded-2xl border border-border/60 bg-background/30 p-5 md:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    {'Step 1'}
                  </p>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {'Bring in one server'}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    {'Step 2'}
                  </p>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {'Set it active and verify RCON'}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    {'Step 3'}
                  </p>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {'Return to Dashboard for live control'}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : servers && servers.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 stagger-in">
          {servers.map((server) => {
            const hasUpdate = updateInfo?.updateAvailable && server.isActive
            return (
              <Card
                key={server.id}
                className={`relative overflow-hidden transition-colors ${
                  server.isActive
                    ? 'border-primary/60 ring-1 ring-primary/25 bg-gradient-to-br from-primary/[0.04] via-card to-card'
                    : 'hover:border-primary/30'
                } ${hasUpdate ? 'border-warning/60' : ''}`}
              >
                {server.isActive && (
                  <div
                    className="absolute top-0 inset-x-0 h-[3px] bg-gradient-to-r from-primary via-primary/80 to-primary/40"
                    aria-hidden="true"
                  />
                )}
                {hasUpdate && !server.isActive && (
                  <div
                    className="absolute top-0 inset-x-0 h-[3px] bg-gradient-to-r from-warning via-warning/80 to-warning/40"
                    aria-hidden="true"
                  />
                )}

                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1.5 min-w-0 flex-1">
                      <CardTitle className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="truncate">{server.name}</span>
                        {server.isActive ? (
                          <Badge variant="default" className="text-xs">
                            <Check className="w-3 h-3 me-1" /> {'Selected'}
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-xs text-muted-foreground"
                          >
                            {'Inactive'}
                          </Badge>
                        )}
                        {(() => {
                          if (server.isActive && currentActiveStatus) {
                            return (
                              <ServerStatusBadge
                                compact
                                host={currentActiveStatus.host}
                                server={currentActiveStatus.server}
                                bridge={currentActiveStatus.bridge}
                              />
                            )
                          }
                          const provider = resolveClientProvider(server)
                          let host
                          if (provider === 'docker-local') {
                            const container = dockerContainers.find(
                              (item) =>
                                item.name === server.dockerContainerName ||
                                item.id === server.dockerContainerName,
                            )
                            const dockerHostStatus =
                              resolveDockerCardHostStatus(
                                dockerAvailable,
                                container,
                              )
                            host =
                              dockerHostStatus === 'unknown'
                                ? {
                                    status: 'unknown',
                                    label: 'Container',
                                    detail: 'Unavailable',
                                  }
                                : {
                                    status: dockerHostStatus,
                                    label: 'Container',
                                  }
                          } else {
                            const status = serverStatuses[String(server.id)]
                            host = status
                              ? {
                                  status: status.running
                                    ? 'running'
                                    : 'stopped',
                                  label: 'Process',
                                }
                              : undefined
                          }
                          const rconStatus = rconStatuses[String(server.id)]
                          const rcon = rconStatus
                            ? rconStatus === 'connected'
                              ? { status: 'connected', label: 'RCON' }
                              : rconStatus === 'unconfigured'
                                ? {
                                    status: 'unknown',
                                    label: 'RCON',
                                    detail: 'Not configured',
                                  }
                                : {
                                    status: 'disconnected',
                                    label: 'RCON',
                                    detail:
                                      rconStatus === 'auth_failed'
                                        ? 'Authentication failed'
                                        : 'Unavailable',
                                  }
                            : undefined
                          return (
                            <ServerStatusBadge
                              compact
                              host={host}
                              server={rcon}
                            />
                          )
                        })()}
                        {hasUpdate && (
                          <Badge variant="warning" className="text-xs">
                            <RefreshCw className="w-3 h-3 me-1" />{' '}
                            {'Update Available'}
                          </Badge>
                        )}
                      </CardTitle>
                      <CardDescription className="font-mono text-xs">
                        {server.serverName}
                      </CardDescription>
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="iconDense"
                          className="shrink-0"
                          aria-label={
                            'Options for ' +
                            String(server.name || server.serverName)
                          }
                        >
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => setEditingServer({ ...server })}
                        >
                          <Edit2 className="w-4 h-4 me-2" /> {'Edit'}
                        </DropdownMenuItem>
                        {!server.isActive && (
                          <DropdownMenuItem
                            onClick={() => handleActivateServer(server)}
                            disabled={activating !== null}
                          >
                            <Power className="w-4 h-4 me-2" /> {'Set Active'}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => openSteamOperation(server, 'update')}
                        >
                          <RefreshCw className="w-4 h-4 me-2" />{' '}
                          {'Update Server'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => openSteamOperation(server, 'verify')}
                        >
                          <ShieldCheck className="w-4 h-4 me-2" />{' '}
                          {'Verify Files'}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setDeleteServer(server)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="w-4 h-4 me-2" />{' '}
                          {'Remove from Panel'}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  {(server.installPath || server.zomboidDataPath) && (
                    <div className="rounded-md border border-border/40 bg-muted/15 divide-y divide-border/30">
                      {server.installPath && (
                        <div className="flex items-start gap-2.5 px-3 py-2">
                          <HardDrive className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              {'Install Path'}
                            </p>
                            <p
                              className="font-mono text-xs text-foreground/85 truncate mt-0.5"
                              title={server.installPath}
                            >
                              {server.installPath}
                            </p>
                          </div>
                        </div>
                      )}
                      {server.zomboidDataPath && (
                        <div className="flex items-start gap-2.5 px-3 py-2">
                          <Database className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              {'Data Path'}
                            </p>
                            <p
                              className="font-mono text-xs text-foreground/85 truncate mt-0.5"
                              title={server.zomboidDataPath}
                            >
                              {server.zomboidDataPath}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {(() => {
                    const container = server.dockerContainerName
                      ? dockerContainers.find(
                          (item) =>
                            item.name === server.dockerContainerName ||
                            item.id === server.dockerContainerName,
                        )
                      : null
                    if (!container || !dockerAvailable) return null
                    const stats =
                      dockerStats[container.id] || dockerStats[container.name]
                    const isRunning = container.state === 'running'
                    const pending = dockerActionPending !== null
                    return (
                      <div className="space-y-2 border-y border-border/50 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Container className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="truncate text-xs font-medium">
                              {container.name}
                            </span>
                            <span
                              className={cn(
                                'text-xs',
                                isRunning
                                  ? 'text-muted-foreground'
                                  : 'text-destructive',
                              )}
                            >
                              {container.state}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="iconDense"
                                  variant="ghost"
                                  disabled={pending || isRunning}
                                  onClick={() =>
                                    handleDockerAction(container, 'start')
                                  }
                                  aria-label={'Start ' + String(container.name)}
                                >
                                  {dockerActionPending ===
                                  `start-${container.id}` ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Play className="h-4 w-4" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {'Start container'}
                              </TooltipContent>
                            </Tooltip>

                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="iconDense"
                                  variant="ghost"
                                  disabled={pending || !isRunning}
                                  onClick={async () => {
                                    const ok = await confirm({
                                      title: 'Stop this container?',
                                      description:
                                        String(container.name) +
                                        " saves through RCON first, but the container itself is stopped by Docker -- if it doesn't exit in time, Docker force-kills it. This can end in an ungraceful termination, unlike the regular Stop button.",
                                      confirmLabel: 'Stop container',
                                    })
                                    if (!ok) return
                                    handleDockerAction(container, 'stop')
                                  }}
                                  aria-label={'Stop ' + String(container.name)}
                                >
                                  {dockerActionPending ===
                                  `stop-${container.id}` ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Square className="h-4 w-4 text-destructive" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {'Stop container'}
                              </TooltipContent>
                            </Tooltip>

                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="iconDense"
                                  variant="ghost"
                                  disabled={pending}
                                  onClick={() =>
                                    handleDockerAction(container, 'restart')
                                  }
                                  aria-label={
                                    'Restart ' + String(container.name)
                                  }
                                >
                                  {dockerActionPending ===
                                  `restart-${container.id}` ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <RotateCw className="h-4 w-4" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {'Restart container'}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                        {stats && (
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                            <span className="text-muted-foreground">
                              {'CPU'}{' '}
                              <span className="font-mono text-foreground">
                                {stats.cpuPercent}%
                              </span>
                            </span>
                            <span className="text-muted-foreground">
                              {'RAM'}{' '}
                              <span className="font-mono text-foreground">
                                {formatBytes(stats.memoryUsed)} (
                                {stats.memoryPercent}%)
                              </span>
                            </span>
                            <span className="text-muted-foreground">
                              {'Net'}{' '}
                              <span className="font-mono text-foreground">
                                {formatBytes(stats.networkRx)} {'in'}
                              </span>
                            </span>
                            <span className="text-muted-foreground">
                              {'Disk'}{' '}
                              <span className="font-mono text-foreground">
                                {formatBytes(stats.diskWrite)} {'write'}
                              </span>
                            </span>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                      <div
                        className="grid place-items-center w-7 h-7 rounded-md border border-primary/25 bg-primary/[0.06] text-primary shrink-0"
                        aria-hidden="true"
                      >
                        <Network className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {'RCON'}
                        </p>
                        <p className="font-mono text-xs text-foreground/90 truncate tabular-nums">
                          {server.rconHost}:{server.rconPort}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                      <div
                        className="grid place-items-center w-7 h-7 rounded-md border border-primary/25 bg-primary/[0.06] text-primary shrink-0"
                        aria-hidden="true"
                      >
                        <Globe className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {'Game Port'}
                        </p>
                        <p className="font-mono text-xs text-foreground/90 tabular-nums">
                          {server.serverPort}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                      <div
                        className="grid place-items-center w-7 h-7 rounded-md border border-border/55 bg-muted/40 text-muted-foreground shrink-0"
                        aria-hidden="true"
                      >
                        <Cpu className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {'Memory'}
                        </p>
                        <p className="font-mono text-xs text-foreground/90 tabular-nums">
                          {server.minMemory}–{server.maxMemory} GB
                        </p>
                      </div>
                    </div>
                  </div>

                  {server.isActive && (updateInfo || gameVersion) && (
                    <div className="p-2.5 rounded-md bg-muted/50 border border-border/50">
                      <div className="flex items-center justify-between flex-wrap gap-y-1">
                        <div className="flex items-center gap-2">
                          {gameVersion && (
                            <Badge
                              variant="outline"
                              className="text-xs font-mono"
                            >
                              v{gameVersion}
                            </Badge>
                          )}
                          {updateInfo && (
                            <>
                              <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                              <Badge
                                variant="secondary"
                                className="text-xs font-mono"
                              >
                                {updateInfo.installed.branch}
                              </Badge>
                            </>
                          )}
                        </div>
                        {updateInfo && (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-muted-foreground">
                              {'Build:'}
                            </span>
                            <span className="font-mono font-medium">
                              {updateInfo.installed.buildId}
                            </span>
                            {updateInfo.updateAvailable && (
                              <>
                                <ArrowRight className="w-3 h-3 text-warning" />
                                <span className="font-mono font-semibold text-warning">
                                  {updateInfo.latest.buildId}
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {!server.isActive && server.branch && (
                    <div className="flex items-center gap-2">
                      <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">
                        {'Branch:'}
                      </span>
                      <Badge variant="secondary" className="text-xs font-mono">
                        {server.branch}
                      </Badge>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1">
                    {(() => {
                      const status = serverStatuses[String(server.id)]
                      const isRunning = resolveServerCardRunning(
                        server,
                        status,
                        currentActiveStatus,
                      )
                      const startPending =
                        serverActionPending === `start-${server.id}`
                      const stopPending =
                        serverActionPending === `stop-${server.id}`
                      const hasManagedContainer =
                        dockerAvailable &&
                        server.dockerContainerName &&
                        dockerContainers.some(
                          (item) =>
                            item.name === server.dockerContainerName ||
                            item.id === server.dockerContainerName,
                        )
                      if (hasManagedContainer) return null
                      if (isRunning === null) {
                        return (
                          <DisabledReason reason={'Unavailable'}>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled
                              title={'Unavailable'}
                            >
                              <Loader2 className="w-4 h-4 me-1.5 animate-spin" />{' '}
                              {'Start'}
                            </Button>
                          </DisabledReason>
                        )
                      }
                      return isRunning ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleInlineStop(server)}
                          disabled={stopPending || serverActionPending !== null}
                          // eslint-disable-next-line local/no-dead-disabled-title -- This title describes the action, not why it is disabled.
                          title={'Stop this server'}
                        >
                          {stopPending ? (
                            <>
                              <Loader2 className="w-4 h-4 me-1.5 animate-spin" />{' '}
                              {'Stopping...'}
                            </>
                          ) : (
                            <>
                              <Square className="w-4 h-4 me-1.5" /> {'Stop'}
                            </>
                          )}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleInlineStart(server)}
                          disabled={
                            startPending || serverActionPending !== null
                          }
                          // eslint-disable-next-line local/no-dead-disabled-title -- This title describes the action, not why it is disabled.
                          title={
                            server.isActive
                              ? 'Start this server'
                              : 'Switch to this server and start it'
                          }
                        >
                          {startPending ? (
                            <>
                              <Loader2 className="w-4 h-4 me-1.5 animate-spin" />{' '}
                              {'Starting...'}
                            </>
                          ) : (
                            <>
                              <Play className="w-4 h-4 me-1.5" /> {'Start'}
                            </>
                          )}
                        </Button>
                      )
                    })()}
                    {hasUpdate && (
                      <Button
                        size="sm"
                        variant="warning"
                        onClick={() => openSteamOperation(server, 'update')}
                      >
                        <RefreshCw className="w-4 h-4 me-1.5" /> {'Update Now'}
                      </Button>
                    )}
                    {!server.isActive && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleActivateServer(server)}
                        disabled={activating === server.id}
                      >
                        {activating === server.id ? (
                          <>
                            <Loader2 className="w-4 h-4 me-1.5 animate-spin" />{' '}
                            {'Activating...'}
                          </>
                        ) : (
                          <>
                            <Power className="w-4 h-4 me-1.5" />{' '}
                            {'Switch to This Server'}
                          </>
                        )}
                      </Button>
                    )}
                  </div>

                  {server.createdAt && (
                    <p className="text-[11px] text-muted-foreground/60 pt-1">
                      {'Added ' +
                        String(
                          new Date(server.createdAt).toLocaleDateString('en'),
                        )}
                    </p>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : null}

      <Dialog
        open={showAddDialog}
        onOpenChange={(open) => !open && resetAddDialog()}
      >
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{'Add Existing Server'}</DialogTitle>
            <DialogDescription>
              {
                'Scan a folder to auto-detect server paths, or enter them manually'
              }
            </DialogDescription>
          </DialogHeader>

          {!!servers?.length && (
            <div className="space-y-1.5 rounded-md border border-border/60 p-3">
              <p className="text-xs font-medium">
                {'Running a second server alongside the first'}
              </p>
              <ul className="space-y-1">
                {[
                  [
                    'Install folder',
                    'its own — SteamCMD and Workshop downloads overwrite a shared one',
                  ],
                  [
                    'Zomboid data folder',
                    'its own — saves, config and DB live here',
                  ],
                  ['Config name', 'unique, it names the .ini'],
                  [
                    'Game port',
                    'PZ takes the port and the next one, so step by 2',
                  ],
                  ['RCON port', 'unique'],
                  ['SteamCMD itself', 'safe to share'],
                ].map(([k, v]) => (
                  <li
                    key={k}
                    className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-2 text-xs"
                  >
                    <span className="text-muted-foreground">{k}</span>
                    <span>{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-4 py-2">
            <>
              <div className="p-4 rounded-lg bg-muted/50 border space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">
                      {'Auto Detect Servers'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {'Scan a folder to find all PZ servers automatically'}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowAutoScan(!showAutoScan)}
                  >
                    {showAutoScan ? 'Manual Entry' : 'Auto Scan'}
                  </Button>
                </div>

                {showAutoScan && (
                  <div className="space-y-3 pt-2">
                    <div className="flex gap-2">
                      <Input
                        value={autoScanPath}
                        onChange={(e) => setAutoScanPath(e.target.value)}
                        placeholder={'Path to scan for PZ servers'}
                        className="font-mono text-sm flex-1"
                      />

                      <Button
                        onClick={handleAutoScan}
                        disabled={autoScanning || !autoScanPath.trim()}
                      >
                        {autoScanning ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Search className="w-4 h-4 me-1" /> {'Scan'}
                          </>
                        )}
                      </Button>
                    </div>

                    {autoScanResult &&
                      autoScanResult.detectedConfigs.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground">
                            {Number(autoScanResult.detectedConfigs.length) === 1
                              ? 'Found ' +
                                String(autoScanResult.detectedConfigs.length) +
                                ' server. Click to select:'
                              : 'Found ' +
                                String(autoScanResult.detectedConfigs.length) +
                                ' servers. Click to select:'}
                          </p>
                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {autoScanResult.detectedConfigs.map(
                              (config, idx) => (
                                <button
                                  type="button"
                                  key={config.serverName || idx}
                                  className="w-full text-start p-3 rounded border bg-background hover:bg-accent cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                                  onClick={() =>
                                    handleSelectScannedConfig(
                                      config,
                                      autoScanResult.installPaths[0],
                                    )
                                  }
                                  aria-label={
                                    'Use detected server ' +
                                    String(
                                      config.publicName || config.serverName,
                                    )
                                  }
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="font-medium">
                                      {config.publicName || config.serverName}
                                    </span>
                                    <Badge
                                      variant="secondary"
                                      className="text-xs font-mono"
                                    >
                                      {config.serverName}.ini
                                    </Badge>
                                  </div>
                                  <div className="text-xs text-muted-foreground mt-1 font-mono truncate">
                                    {'📁 Data: ' + String(config.dataPath)}
                                  </div>
                                  {config.matchedBatFile ? (
                                    <div className="mt-1 text-xs font-mono text-primary truncate">
                                      {'✓ Matched: ' +
                                        String(config.matchedBatFile)}
                                    </div>
                                  ) : autoScanResult.installPaths.length > 0 ? (
                                    <div className="mt-1 text-xs text-warning">
                                      {
                                        '⚠ No matching startup script - will use default install path'
                                      }
                                    </div>
                                  ) : (
                                    <div className="mt-1 text-xs text-warning">
                                      {
                                        '⚠ No install path found - enter manually below'
                                      }
                                    </div>
                                  )}
                                </button>
                              ),
                            )}
                          </div>

                          <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                            {autoScanResult.installPaths.length > 0 && (
                              <p>
                                {'📁 Install paths found: ' +
                                  String(autoScanResult.installPaths.length)}
                              </p>
                            )}
                            {autoScanResult.customBatFiles &&
                              autoScanResult.customBatFiles.length > 0 && (
                                <p>
                                  {'🎯 Custom startup scripts: ' +
                                    String(
                                      autoScanResult.customBatFiles
                                        .map((b) => b.fileName)
                                        .join(', '),
                                    )}
                                </p>
                              )}
                          </div>
                        </div>
                      )}
                  </div>
                )}
              </div>

              {!showAutoScan && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>{'Server Data Path *'}</Label>
                    <div className="flex gap-2">
                      <Input
                        value={newServer.zomboidDataPath}
                        onChange={(e) => {
                          setNewServer({
                            ...newServer,
                            zomboidDataPath: e.target.value,
                          })
                          setDetectResult(null)
                          setDetectError(null)
                          setImportIniFrom(null)
                        }}
                        placeholder={'Path to Zomboid data folder'}
                        className="font-mono text-sm flex-1"
                        maxLength={260}
                      />

                      <Button
                        variant="secondary"
                        onClick={handleDetectServer}
                        disabled={
                          detecting || !newServer.zomboidDataPath.trim()
                        }
                      >
                        {detecting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Search className="w-4 h-4 me-1" /> {'Detect'}
                          </>
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {
                        'The folder containing Server/, Saves/, Logs/ subfolders'
                      }
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>{'Server Install Path (Optional)'}</Label>
                    <Input
                      value={newServer.installPath}
                      onChange={(e) =>
                        setNewServer({
                          ...newServer,
                          installPath: e.target.value,
                        })
                      }
                      placeholder={
                        runtimeInfo?.family === 'windows'
                          ? 'Path to the PZ server folder containing StartServer64.bat'
                          : runtimeInfo?.family === 'posix'
                            ? 'Path to the PZ server folder containing start-server.sh'
                            : 'Path to the Project Zomboid server folder'
                      }
                      className="font-mono text-sm"
                      maxLength={260}
                    />
                    {isCustomLauncherPath(newServer.installPath) && (
                      <Alert className="border-warning/40 bg-warning/10">
                        <AlertCircle className="h-4 w-4 text-warning" />
                        <AlertTitle className="text-warning">
                          {'Custom launcher mode'}
                        </AlertTitle>
                        <AlertDescription>
                          {
                            'This path points at a script, not a folder — the panel will launch it as-is and will never regenerate or edit it. Settings that are normally written into a launch script for you (memory, admin password, the data path, the server name) will not reach the server unless you put them in this script yourself.'
                          }
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </div>
              )}

              {detectError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
                  <AlertCircle className="w-4 h-4" />
                  <span className="text-sm">{detectError}</span>
                </div>
              )}

              {detectResult && (
                <div className="space-y-4">
                  {detectResult.detectedServers.length === 0 ? (
                    <Alert className="border-warning/40 bg-warning/10">
                      <AlertCircle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {'No server configs found'}
                      </AlertTitle>
                      <AlertDescription>
                        {'Run the server once to create the INI file.'}
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <>
                      {detectResult.detectedServers.length > 1 && (
                        <div className="space-y-2">
                          <Label>{'Select Server Configuration'}</Label>
                          <Select
                            value={selectedServerConfig}
                            onValueChange={(val) => {
                              const config = detectResult.detectedServers.find(
                                (s) => s.serverName === val,
                              )
                              if (config) handleSelectServerConfig(config)
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={'Choose a server...'} />
                            </SelectTrigger>
                            <SelectContent>
                              {detectResult.detectedServers.map((s) => (
                                <SelectItem
                                  key={s.serverName}
                                  value={s.serverName}
                                >
                                  {s.publicName || s.serverName} ({s.serverName}
                                  .ini)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {selectedServerConfig && (
                        <div className="space-y-3 rounded-lg border bg-muted/50 p-4">
                          <div className="mb-3 flex items-center gap-2 text-primary">
                            <CheckCircle className="w-4 h-4" />
                            <span className="font-medium">
                              {'Server detected successfully!'}
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                            <div>
                              <span className="text-muted-foreground">
                                {'Server Name:'}
                              </span>
                              <p className="font-medium">{newServer.name}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">
                                {'Config File:'}
                              </span>
                              <p className="font-mono">
                                {newServer.serverName}.ini
                              </p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">
                                {'Game Port:'}
                              </span>
                              <p className="font-mono">
                                {newServer.serverPort}
                              </p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">
                                {'RCON Port:'}
                              </span>
                              <p className="font-mono">{newServer.rconPort}</p>
                            </div>
                          </div>

                          {tandemConflicts.length > 0 && (
                            <div className="space-y-1.5 rounded-md border border-destructive/50 bg-destructive/5 p-3">
                              <p className="text-xs font-medium text-destructive">
                                {
                                  'Clashes with a server already added — both cannot run at once'
                                }
                              </p>
                              <ul className="space-y-1">
                                {tandemConflicts.map(
                                  (
                                    c: { label: string; detail: string },
                                    i: number,
                                  ) => (
                                    <li
                                      key={`${c.label}-${i}`}
                                      className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-2 text-xs"
                                    >
                                      <span className="text-muted-foreground">
                                        {c.label}
                                      </span>
                                      <span>{c.detail}</span>
                                    </li>
                                  ),
                                )}
                              </ul>
                            </div>
                          )}

                          <div className="space-y-2 mt-2">
                            <Label>{'RCON Password *'}</Label>
                            <PasswordInput
                              placeholder={
                                importIniFrom
                                  ? 'Leave blank to import automatically'
                                  : 'Enter RCON password'
                              }
                              value={newServer.rconPassword}
                              className="bg-background"
                              onChange={(value) => {
                                setNewServer({
                                  ...newServer,
                                  rconPassword: value,
                                })
                                setImportIniFrom(null)
                              }}
                              label={'RCON password'}
                            />
                            {!newServer.rconPassword && importIniFrom ? (
                              <p className="flex items-center gap-1 text-xs text-primary">
                                <CheckCircle className="w-3 h-3" />{' '}
                                {'Imported automatically from ' +
                                  String(newServer.serverName) +
                                  '.ini — leave blank to use it, or type a new one to override.'}
                              </p>
                            ) : !newServer.rconPassword ? (
                              <p className="text-xs text-warning">
                                <>
                                  {
                                    'Required for server control. You can also set '
                                  }
                                  {'RCONPassword=yourpassword'}
                                  {' in your '}
                                  {newServer.serverName}
                                  {'.ini file.'}
                                </>
                              </p>
                            ) : (
                              <p className="flex items-center gap-1 text-xs text-primary">
                                <CheckCircle className="w-3 h-3" />{' '}
                                {'Password set'}
                              </p>
                            )}
                            <RconTestConnection
                              host={newServer.rconHost || '127.0.0.1'}
                              port={newServer.rconPort}
                              password={newServer.rconPassword}
                            />
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                            <div className="space-y-2">
                              <Label>{'Min Memory (GB)'}</Label>
                              <NumberInput
                                min={1}
                                max={64}
                                value={newServer.minMemory}
                                className="bg-background"
                                clamp={(n) => Math.max(1, n)}
                                onChange={(minMemory) =>
                                  setNewServer({ ...newServer, minMemory })
                                }
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>{'Max Memory (GB)'}</Label>
                              <NumberInput
                                min={1}
                                max={64}
                                value={newServer.maxMemory}
                                className="bg-background"
                                clamp={(n) => Math.max(1, n)}
                                onChange={(maxMemory) =>
                                  setNewServer({ ...newServer, maxMemory })
                                }
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetAddDialog}>
              {'Cancel'}
            </Button>

            <Button
              onClick={handleAddExistingServer}
              disabled={
                addingServer ||
                !selectedServerConfig ||
                (!newServer.rconPassword && !importIniFrom)
              }
            >
              {addingServer ? (
                <>
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />{' '}
                  {'Adding...'}
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4 me-2" /> {'Add Server'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingServer}
        onOpenChange={() => setEditingServer(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{'Edit Server'}</DialogTitle>
            <DialogDescription>
              {'Update server configuration settings'}
            </DialogDescription>
          </DialogHeader>

          {editingServer && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{'Display Name'}</Label>
                  <Input
                    value={editingServer.name}
                    onChange={(e) =>
                      setEditingServer({
                        ...editingServer,
                        name: e.target.value,
                      })
                    }
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>{'Server Name'}</Label>
                    <HelpTip label={'Server Name'}>
                      {
                        "This must match your server's real internal name — the .ini filename and save folder it uses (e.g. servertest.ini → Saves/Multiplayer/servertest). Changing it here doesn't rename any files; it points the panel at a different config and save folder, which may not exist."
                      }
                    </HelpTip>
                  </div>
                  <Input
                    value={editingServer.serverName}
                    onChange={(e) =>
                      setEditingServer({
                        ...editingServer,
                        serverName: e.target.value,
                      })
                    }
                    maxLength={64}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{'Managed Docker Container'}</Label>
                  <Input
                    value={editingServer.dockerContainerName || ''}
                    onChange={(e) =>
                      setEditingServer({
                        ...editingServer,
                        dockerContainerName: e.target.value || null,
                      })
                    }
                    placeholder={'Optional explicit container name'}
                    maxLength={128}
                  />
                  <p className="text-xs text-muted-foreground">
                    {
                      'Requires PANEL_DOCKER_CONTROL_ENABLED and the container label zomboid-panel.managed=true.'
                    }
                  </p>
                </div>
              </div>

              <>
                <div className="space-y-2">
                  <Label>{'Install Path'}</Label>
                  <Input
                    value={editingServer.installPath}
                    onChange={(e) =>
                      setEditingServer({
                        ...editingServer,
                        installPath: e.target.value,
                      })
                    }
                    className="font-mono text-sm"
                  />
                  {isCustomLauncherPath(editingServer.installPath) && (
                    <Alert className="border-warning/40 bg-warning/10">
                      <AlertCircle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {'Custom launcher mode'}
                      </AlertTitle>
                      <AlertDescription>
                        {
                          'This path points at a script, not a folder — the panel will launch it as-is and will never regenerate or edit it. Settings that are normally written into a launch script for you (memory, admin password, the data path, the server name) will not reach the server unless you put them in this script yourself.'
                        }
                      </AlertDescription>
                    </Alert>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>{'Zomboid Data Path'}</Label>
                    <HelpTip label={'Zomboid Data Path'}>
                      {
                        "The folder holding your server's actual save data and config (Saves/, Server/, Logs/). Changing this doesn't move any files — it just tells the panel to look somewhere else. Point it at the wrong folder and actions like wiping saves or taking backups will act on the wrong data, or find nothing at all."
                      }
                    </HelpTip>
                  </div>
                  <Input
                    value={editingServer.zomboidDataPath || ''}
                    onChange={(e) =>
                      setEditingServer({
                        ...editingServer,
                        zomboidDataPath: e.target.value,
                      })
                    }
                    className="font-mono text-sm"
                    placeholder={'Leave empty for default'}
                  />
                </div>

                {managedLifecycleSupported &&
                  !editingServer.dockerContainerName &&
                  !editingServer.dockerContainerId && (
                    <div className="space-y-3 rounded-md border border-border/60 p-3">
                      <div className="space-y-1">
                        <Label>{'Lifecycle Provider'}</Label>
                        <p className="text-xs text-muted-foreground">
                          {
                            'Direct starts the game server as a panel child process. systemd and OpenRC keep it in an independent operating-system service.'
                          }
                        </p>
                      </div>
                      <Select
                        value={editingServer.lifecycleProvider || 'direct'}
                        onValueChange={(
                          value: 'direct' | 'systemd' | 'openrc',
                        ) =>
                          setEditingServer({
                            ...editingServer,
                            lifecycleProvider: value,
                          })
                        }
                        disabled={lifecyclePending}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="direct">
                            {'Direct (default)'}
                          </SelectItem>
                          <SelectItem value="systemd">systemd</SelectItem>
                          <SelectItem value="openrc">OpenRC</SelectItem>
                        </SelectContent>
                      </Select>
                      <Alert className="border-warning/40 bg-warning/10">
                        <AlertCircle className="h-4 w-4 text-warning" />
                        <AlertDescription>
                          {
                            'Managed services are opt-in. Download and install the generated service file first, stop every existing instance, then activate it. The panel never installs files in /etc or runs sudo.'
                          }
                        </AlertDescription>
                      </Alert>
                      <div className="flex flex-wrap gap-2">
                        {(editingServer.lifecycleProvider || 'direct') !==
                          'direct' && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={lifecyclePending}
                            onClick={() =>
                              handleDownloadLifecycleTemplate(editingServer)
                            }
                          >
                            {lifecyclePending ? (
                              <Loader2 className="me-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Download className="me-2 h-4 w-4" />
                            )}
                            {'Download Service File'}
                          </Button>
                        )}
                        {(editingServer.lifecycleProvider || 'direct') !==
                          (servers?.find(
                            (server) => server.id === editingServer.id,
                          )?.lifecycleProvider || 'direct') && (
                          <Button
                            type="button"
                            variant="warning"
                            size="sm"
                            disabled={lifecyclePending}
                            onClick={() =>
                              handleActivateLifecycleProvider(editingServer)
                            }
                          >
                            {lifecyclePending && (
                              <Loader2 className="me-2 h-4 w-4 animate-spin" />
                            )}
                            {'Activate Provider'}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}

                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    {'Custom Start Command'}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[280px]">
                        <p className="text-xs">
                          {
                            'Override the default startup script with a custom command. Supports arguments. Leave empty and the panel will regenerate the default bat/sh startup script from these settings every time the server starts — this OVERWRITES that file, including any manual edits, though a changed file is backed up first.'
                          }
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Input
                    value={editingServer.startCommand || ''}
                    onChange={(e) =>
                      setEditingServer({
                        ...editingServer,
                        startCommand: e.target.value,
                      })
                    }
                    className="font-mono text-sm"
                    placeholder={
                      runtimeInfo?.family === 'windows'
                        ? 'e.g. StartServer64.bat -servername MyServer'
                        : runtimeInfo?.family === 'posix'
                          ? 'e.g. ./start-server.sh -servername MyServer'
                          : 'Command used to start this server'
                    }
                    maxLength={1024}
                  />
                  {editingServer.startCommand &&
                    /[&|;<>`${}()!\[\]]/.test(editingServer.startCommand) && (
                      <p className="text-xs text-destructive">
                        {'Command contains disallowed shell characters'}
                      </p>
                    )}
                </div>
                <div className="flex items-start gap-3 rounded-md border border-border/60 p-3">
                  <Checkbox
                    id={`edit-use-no-steam-${editingServer.id}`}
                    checked={!!editingServer.useNoSteam}
                    onCheckedChange={(checked) =>
                      setEditingServer({
                        ...editingServer,
                        useNoSteam: checked === true,
                      })
                    }
                  />
                  <div className="space-y-1">
                    <Label htmlFor={`edit-use-no-steam-${editingServer.id}`}>
                      {'Launch without Steam'}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {
                        'Use the non-Steam dedicated-server mode on the next start.'
                      }
                    </p>
                  </div>
                </div>
              </>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    {'RCON host'}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[200px]">
                        <p className="text-xs">
                          {
                            'Leave as 127.0.0.1 if the panel runs on the same machine as the game server'
                          }
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Input
                    value={editingServer.rconHost}
                    onChange={(e) =>
                      setEditingServer({
                        ...editingServer,
                        rconHost: e.target.value,
                      })
                    }
                    placeholder="127.0.0.1"
                  />
                  <p className="text-xs text-muted-foreground">
                    {
                      'Use 127.0.0.1 when the panel and server share this machine.'
                    }
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>{'RCON Port'}</Label>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={editingServer.rconPort}
                    onChange={(e) => {
                      const val = parseInt(e.target.value)
                      if (!isNaN(val))
                        setEditingServer({
                          ...editingServer,
                          rconPort: Math.min(65535, Math.max(1, val)),
                        })
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{'RCON Password'}</Label>
                  <PasswordInput
                    value={editingServer.rconPassword}
                    onChange={(value) =>
                      setEditingServer({
                        ...editingServer,
                        rconPassword: value,
                      })
                    }
                    label={'RCON password'}
                  />
                  <RconTestConnection
                    host={editingServer.rconHost}
                    port={editingServer.rconPort}
                    password={editingServer.rconPassword}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    {'Admin Password'}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[240px]">
                        <p className="text-xs">
                          {
                            'Server admin password passed as -adminpassword launch argument. Takes effect on next server start.'
                          }
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <PasswordInput
                    value={editingServer.adminPassword || ''}
                    onChange={(value) =>
                      setEditingServer({
                        ...editingServer,
                        adminPassword: value,
                      })
                    }
                    placeholder={'Set admin password'}
                    label={'admin password'}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>{'Game Port'}</Label>
                  <NumberInput
                    min={1}
                    max={65534}
                    value={editingServer.serverPort}
                    onChange={(serverPort) =>
                      setEditingServer({ ...editingServer, serverPort })
                    }
                  />
                </div>
                <>
                  <div className="space-y-2">
                    <Label>{'Min Memory (GB)'}</Label>
                    <NumberInput
                      min={1}
                      max={64}
                      value={editingServer.minMemory}
                      clamp={(n) => Math.max(1, n)}
                      onChange={(minMemory) =>
                        setEditingServer({ ...editingServer, minMemory })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{'Max Memory (GB)'}</Label>
                    <NumberInput
                      min={1}
                      max={64}
                      value={editingServer.maxMemory}
                      clamp={(n) => Math.max(1, n)}
                      onChange={(maxMemory) =>
                        setEditingServer({ ...editingServer, maxMemory })
                      }
                    />
                  </div>
                </>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingServer(null)}>
              {'Cancel'}
            </Button>

            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              <Check className="w-4 h-4 me-2" />{' '}
              {savingEdit ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteServer}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteServer(null)
            setDeleteFiles(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{'Remove Server from Panel?'}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>
                  {'This will remove "' +
                    String(deleteServer?.name) +
                    '" from the panel management.'}
                </p>

                {deleteServer?.installPath && (
                  <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/50">
                    <Checkbox
                      id="deleteFiles"
                      checked={deleteFiles}
                      onCheckedChange={(checked) =>
                        setDeleteFiles(checked === true)
                      }
                      disabled={deleting}
                      className="mt-1"
                    />

                    <label
                      htmlFor="deleteFiles"
                      className="text-sm cursor-pointer"
                    >
                      <span className="font-medium text-destructive">
                        {'Also delete server files'}
                      </span>
                      <p className="text-muted-foreground mt-1">
                        {'This will permanently delete all files in:'}
                        <br />
                        <code className="text-xs bg-background px-1 rounded">
                          {deleteServer?.installPath}
                        </code>
                      </p>
                    </label>
                  </div>
                )}

                {deleteFiles &&
                  isZomboidDataNestedInInstall(
                    deleteServer?.zomboidDataPath,
                    deleteServer?.installPath,
                  ) && (
                    <div className="rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-sm">
                      <p className="font-medium text-destructive">
                        {'This will also delete the world save'}
                      </p>
                      <p className="text-muted-foreground">
                        {
                          "This server's Zomboid data folder is inside the install folder above, so there's no separate copy — deleting it destroys the world save too. The panel refuses this until you move the data path in Settings or back it up yourself:"
                        }
                      </p>
                      <code className="text-xs bg-background px-1 rounded">
                        {deleteServer?.zomboidDataPath}
                      </code>
                    </div>
                  )}

                {!deleteFiles && !deleting && (
                  <p className="text-sm text-muted-foreground">
                    {
                      'Server files will NOT be deleted - you can add this server back later.'
                    }
                  </p>
                )}

                {deleting && (
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>
                        {deleteFiles
                          ? 'Deleting server files...'
                          : 'Removing server...'}
                      </span>
                    </div>
                    <Progress value={deleteProgress} className="h-1.5" />
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {'Cancel'}
            </AlertDialogCancel>

            <Button
              onClick={handleDeleteServer}
              disabled={deleting}
              className={
                deleteFiles
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : ''
              }
            >
              {deleting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin me-2" />
                  {'Removing...'}
                </>
              ) : deleteFiles ? (
                'Delete Everything'
              ) : (
                'Remove from Panel'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!steamOperation}
        onOpenChange={(open) =>
          !open && (!steamRunning || steamStalled) && setSteamOperation(null)
        }
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {steamOperation?.type === 'verify' ? (
                <>
                  <ShieldCheck className="w-5 h-5" /> {'Verify Game Files'}
                </>
              ) : (
                <>
                  <RefreshCw className="w-5 h-5" /> {'Update Server'}
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {steamOperation?.type === 'verify'
                ? 'Check and repair game files using SteamCMD'
                : 'Download the latest version using SteamCMD'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{'SteamCMD Path *'}</Label>
              <Input
                value={steamcmdPath}
                onChange={(e) => setSteamcmdPath(e.target.value)}
                placeholder={'Path to SteamCMD folder'}
                className="font-mono text-sm"
                disabled={steamRunning}
              />
              <p className="text-xs text-muted-foreground">
                {'Folder containing steamcmd'}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{'Server Install Path'}</Label>
              <Input
                value={getInstallFolder(steamOperation?.server.installPath)}
                disabled
                className="font-mono text-sm bg-muted"
              />

              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={steamRunning || clearingInstall}
                onClick={() => {
                  setConfirmClearInstall(true)
                }}
              >
                <Trash2 className="w-3.5 h-3.5 me-2" />{' '}
                {'Clear Installation Folder'}
              </Button>

              <p className="text-xs text-muted-foreground">
                {
                  'Deletes everything in the install path so you can reinstall from scratch. Use this if SteamCMD updates keep failing (stuck or corrupted download state) instead of fixing it manually.'
                }
              </p>
            </div>

            <div className="space-y-2">
              <Label>
                {'Steam Branch'}{' '}
                {loadingBranches && (
                  <Loader2 className="inline-block w-3 h-3 ms-1 animate-spin" />
                )}
              </Label>
              <Select
                value={steamOperation?.branch || 'public'}
                onValueChange={(value) =>
                  steamOperation &&
                  setSteamOperation({ ...steamOperation, branch: value })
                }
                disabled={steamRunning || loadingBranches}
              >
                <SelectTrigger className="w-full text-foreground">
                  {(() => {
                    const current = availableBranches.find(
                      (b) => b.name === steamOperation?.branch,
                    )
                    if (loadingBranches)
                      return (
                        <span className="text-muted-foreground">
                          {'Loading branches...'}
                        </span>
                      )
                    if (!current)
                      return (
                        <span className="text-muted-foreground">
                          {'Select branch'}
                        </span>
                      )
                    return (
                      <span className="flex items-center gap-2">
                        <span className="capitalize">
                          {current.name === 'public'
                            ? 'Public (Stable)'
                            : current.name}
                        </span>
                        {(() => {
                          const sb = (steamOperation?.server.branch || '')
                            .trim()
                            .toLowerCase()
                          const ib = (updateInfo?.installed?.branch || '')
                            .trim()
                            .toLowerCase()
                          const isCurrent =
                            current.name === ib || current.name === sb
                          return isCurrent ? (
                            <span className="rounded border border-border/60 px-1 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                              {'current'}
                            </span>
                          ) : null
                        })()}
                      </span>
                    )
                  })()}
                </SelectTrigger>
                <SelectContent>
                  {availableBranches.map((b) => (
                    <SelectItem key={b.name} value={b.name}>
                      <div className="flex flex-col">
                        <span className="capitalize">
                          {b.name === 'public' ? 'Public (Stable)' : b.name}
                        </span>
                        {b.description && (
                          <span className="text-xs text-muted-foreground">
                            {b.description}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const selected = availableBranches.find(
                    (b) => b.name === steamOperation?.branch,
                  )
                  if (!selected)
                    return 'Select the Steam branch to download from'
                  const details = [selected.description]
                  if (selected.buildId)
                    details.push('Build ' + String(selected.buildId))
                  if (selected.timeUpdated)
                    details.push(
                      'Updated ' +
                        String(
                          new Date(selected.timeUpdated).toLocaleString('en'),
                        ),
                    )
                  return details.join(' - ')
                })()}
              </p>
            </div>

            {steamLogs.length > 0 && (
              <div className="space-y-2">
                <Label>{'Progress'}</Label>
                <div className="h-48 overflow-y-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs text-foreground">
                  {steamLogs.map((log, i) => (
                    <div key={i}>{log}</div>
                  ))}
                </div>
              </div>
            )}
            {steamStalled && (
              <Alert variant="destructive">
                <AlertTitle>{'No progress received'}</AlertTitle>
                <AlertDescription>
                  {
                    'No SteamCMD activity has arrived for three minutes. The operation may still be running; check the server status before trying again.'
                  }
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSteamOperation(null)}
              disabled={steamRunning && !steamStalled}
            >
              {steamStalled
                ? 'Close Anyway'
                : steamRunning
                  ? 'Running...'
                  : steamCompleted
                    ? 'Close'
                    : 'Cancel'}
            </Button>
            {!steamCompleted && (
              <Button
                onClick={handleStartSteamOperation}
                disabled={steamRunning || !steamcmdPath.trim()}
              >
                {steamRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />{' '}
                    {'Running...'}
                  </>
                ) : steamOperation?.type === 'verify' ? (
                  <>
                    <ShieldCheck className="w-4 h-4 me-2" /> {'Start Verify'}
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 me-2" /> {'Start Update'}
                  </>
                )}
              </Button>
            )}
            {steamCompleted === 'success' && (
              <Button variant="default" onClick={() => setSteamOperation(null)}>
                <CheckCircle2 className="w-4 h-4 me-2" /> {'Done'}
              </Button>
            )}
            {steamCompleted === 'error' && (
              <Button
                onClick={() => {
                  setSteamCompleted(null)
                  handleStartSteamOperation()
                }}
                disabled={!steamcmdPath.trim()}
              >
                <RefreshCw className="w-4 h-4 me-2" /> {'Retry'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmClearInstall}
        onOpenChange={(open) =>
          !open && !clearingInstall && setConfirmClearInstall(false)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{'Clear Installation Folder?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {'This permanently deletes everything in'}{' '}
              <code className="text-xs bg-background px-1 rounded">
                {getInstallFolder(steamOperation?.server.installPath)}
              </code>{' '}
              {
                "— including the game files, SteamCMD's download state, and any mods installed there. Use this to recover from a SteamCMD update that keeps failing (corrupted or stuck installation). You'll need to run Start Update again afterward to reinstall from scratch. This does not affect your save data."
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearingInstall}>
              {'Cancel'}
            </AlertDialogCancel>

            <Button
              onClick={handleClearInstallFolder}
              disabled={clearingInstall}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearingInstall ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin me-2" />
                  {'Clearing...'}
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 me-2" />
                  {'Clear Folder'}
                </>
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DiscoverySetup
        open={!!discoverySetupMount}
        onOpenChange={(open) => !open && setDiscoverySetupMount(null)}
        mount={discoverySetupMount}
        onCreated={() => {
          fetchServers()
          fetchServerStatuses()
        }}
      />
    </div>
  )
}
