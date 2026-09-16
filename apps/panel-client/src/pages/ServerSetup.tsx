import { useState, useEffect, useContext, useRef, useMemo } from 'react'
import {
  Download,
  Server,
  CheckCircle,
  Loader2,
  Terminal,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Eye,
  EyeOff,
  Cpu,
  FolderOpen,
  Zap,
  Shield,
  Settings2,
  Plus,
  HardDrive,
  Play,
  Sparkles,
  RefreshCw,
  Copy,
  Check,
  Info,
  ArrowRight,
  AlertTriangle,
} from 'lucide-react'
import { configApi, serverApi, serversApi, debugApi } from '@/lib/api'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { HelpTip } from '@/components/HelpTip'
import { NumberInput } from '@/components/NumberInput'
import { getInstallProgressMessage } from '@/lib/installProgressMessage'
import { useNavigate } from '@tanstack/react-router'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { SocketContext } from '@/contexts/SocketContext'
import { Slider } from '@/components/ui/slider'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { reportClientError } from '@/lib/client-errors'
import {
  getUserErrorMessage,
  rawErrorMessageIntentional,
} from '@/lib/errorMessage'
import { cn, copyText, formatUptime } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { FolderBrowser } from '@/components/FolderBrowser'

interface InstallLog {
  type:
    'info' | 'success' | 'error' | 'warning' | 'command' | 'stdout' | 'stderr'
  message: string
  timestamp: Date
}

type SetupMode = 'select' | 'full' | 'quick'

function handleCardKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  onActivate: () => void,
) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    onActivate()
  }
}

export function isValidInstallPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535
}

export function isValidGamePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65534
}

function formatPort(port: number): string {
  return Number.isFinite(port) ? String(port) : '—'
}

function formatMemory(gb: number): string {
  return Number.isFinite(gb) ? String(gb) : '—'
}

export const INSTALL_INFLIGHT_KEY = 'zcp-install-inflight'
const INSTALL_INFLIGHT_STALE_MS = 6 * 60 * 60 * 1000

export interface InstallInFlightMarker {
  installPath: string
  serverName: string
  startedAt: number
}

export function readInstallInFlightMarker(): InstallInFlightMarker | null {
  try {
    const raw = localStorage.getItem(INSTALL_INFLIGHT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed.installPath === 'string' &&
      typeof parsed.serverName === 'string' &&
      typeof parsed.startedAt === 'number'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function writeInstallInFlightMarker(
  marker: InstallInFlightMarker,
): void {
  try {
    localStorage.setItem(INSTALL_INFLIGHT_KEY, JSON.stringify(marker))
  } catch {
    // Best-effort (private browsing / storage quota) -- the wizard still
    // works, it just can't warn about this specific install after a reload.
  }
}

export function clearInstallInFlightMarker(): void {
  try {
    localStorage.removeItem(INSTALL_INFLIGHT_KEY)
  } catch {
    // ignore
  }
}

function generatePassword(length = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

const LINUX_SERVICE_INSTALL_PATH = '/opt/zomboid-panel/data/pzserver'

export function installationErrorGuidance(
  rawMessage: string,
  displayMessage: string,
  platform: string | null,
) {
  if (!rawMessage.startsWith('Installation path is not writable:')) {
    return displayMessage
  }
  if (platform !== 'linux') {
    return displayMessage
  }

  return (
    String(rawMessage) +
    ' On Linux, use ' +
    String(LINUX_SERVICE_INSTALL_PATH) +
    ', or add both your install folder and its _Data folder to ReadWritePaths in zomboid-panel.service, then restart the service.'
  )
}

export default function ServerSetup() {
  const runtimeInfo = useRuntimeInfo()
  const [setupMode, setSetupMode] = useState<SetupMode>('select')
  const [currentStep, setCurrentStep] = useState(1)

  const [steamCmdPath, setSteamCmdPath] = useState('')
  const [hasSteamCmd, setHasSteamCmd] = useState(false)

  const [installPath, setInstallPath] = useState('')
  const [serverName, setServerName] = useState('myserver')
  const [branch, setBranch] = useState('public')
  const [availableBranches, setAvailableBranches] = useState<
    Array<{ name: string; description: string; buildId?: string | null }>
  >([
    { name: 'public', description: 'Stable release (Build 42)' },
    { name: 'b41multiplayer', description: 'Build 41 Multiplayer' },
  ])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [useCustomDataPath, setUseCustomDataPath] = useState(false)
  const [zomboidDataPath, setZomboidDataPath] = useState('')
  const [rconPassword, setRconPassword] = useState('')
  const [rconPort, setRconPort] = useState(27015)
  const [showRconPassword, setShowRconPassword] = useState(false)
  const [copiedPassword, setCopiedPassword] = useState(false)

  const [minMemory, setMinMemory] = useState(4)
  const [maxMemory, setMaxMemory] = useState(8)
  const [serverPort, setServerPort] = useState(16261)
  const [useUpnp, setUseUpnp] = useState(true)
  const [adminPassword, setAdminPassword] = useState('')
  const [showAdminPassword, setShowAdminPassword] = useState(false)
  const missingAdminPassword = adminPassword.trim().length === 0
  const [useNoSteam, setUseNoSteam] = useState(false)
  const [useDebug, setUseDebug] = useState(false)
  const [systemRam, setSystemRam] = useState<{
    totalGB: number
    freeGB: number
    recommendedMin: number
    recommendedMax: number
  } | null>(null)
  const [detectingRam, setDetectingRam] = useState(false)
  const serverPlatform = runtimeInfo?.platform ?? null

  const [installing, setInstalling] = useState(false)
  const [logs, setLogs] = useState<InstallLog[]>([])
  const [installComplete, setInstallComplete] = useState(false)
  const [resumeMarker, setResumeMarker] =
    useState<InstallInFlightMarker | null>(null)
  const [installProgress, setInstallProgress] = useState<{
    percent: number
    downloaded: string
    total: string
    status: string
  } | null>(null)

  const [downloadingSteamCmd, setDownloadingSteamCmd] = useState(false)
  const [steamCmdStatus, setSteamCmdStatus] = useState<string>('')
  const installViaSteamCmdRef = useRef(false)

  const { toast } = useToast()
  const socket = useContext(SocketContext)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const navigateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [startingServer, setStartingServer] = useState(false)

  const formStateRef = useRef({
    serverName,
    installPath,
    zomboidDataPath,
    useCustomDataPath,
    rconPort,
    rconPassword,
    adminPassword,
    serverPort,
    minMemory,
    maxMemory,
    useNoSteam,
    useDebug,
    useUpnp,
  })
  useEffect(() => {
    formStateRef.current = {
      serverName,
      installPath,
      zomboidDataPath,
      useCustomDataPath,
      rconPort,
      rconPassword,
      adminPassword,
      serverPort,
      minMemory,
      maxMemory,
      useNoSteam,
      useDebug,
      useUpnp,
    }
  }, [
    serverName,
    installPath,
    zomboidDataPath,
    useCustomDataPath,
    rconPort,
    rconPassword,
    adminPassword,
    serverPort,
    minMemory,
    maxMemory,
    useNoSteam,
    useDebug,
    useUpnp,
  ])

  useEffect(
    () => () => {
      if (navigateTimerRef.current) clearTimeout(navigateTimerRef.current)
    },
    [],
  )

  const totalSteps = setupMode === 'quick' ? 3 : 4

  const stepValidation = useMemo(() => {
    if (setupMode === 'quick') {
      return {
        1: installPath.length > 0,
        2:
          serverName.length > 0 &&
          rconPassword.length >= 6 &&
          adminPassword.trim().length > 0,
        3: true,
      }
    }
    return {
      1: steamCmdPath.length > 0 && hasSteamCmd,
      2: installPath.length > 0 && serverName.length > 0,
      3: rconPassword.length >= 6 && adminPassword.trim().length > 0,
      4: true,
    }
  }, [
    setupMode,
    steamCmdPath,
    hasSteamCmd,
    installPath,
    serverName,
    rconPassword,
    adminPassword,
  ])

  const canProceed = stepValidation[currentStep as keyof typeof stepValidation]

  useEffect(() => {
    if (!rconPassword) {
      setRconPassword(generatePassword(12))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only: only generate once if blank

  useEffect(() => {
    handleAutoDetectRam()
  }, [])

  useEffect(() => {
    const marker = readInstallInFlightMarker()
    if (!marker) return
    if (Date.now() - marker.startedAt > INSTALL_INFLIGHT_STALE_MS) {
      clearInstallInFlightMarker()
      return
    }
    setResumeMarker(marker)
  }, [])

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await configApi.getAppSettings()
        const settings = data.settings || {}
        if (settings.steamcmdPath) {
          setSteamCmdPath(settings.steamcmdPath)
          setHasSteamCmd(true)
        }
        if (settings.serverPath) setInstallPath(settings.serverPath)
        if (settings.serverName) setServerName(settings.serverName)
        if (settings.zomboidDataPath) {
          setZomboidDataPath(settings.zomboidDataPath)
          setUseCustomDataPath(true)
        }
        if (settings.minMemory)
          setMinMemory(
            Math.min(
              16,
              Math.max(2, Math.round(settings.minMemory / 1024) || 4),
            ),
          )
        if (settings.maxMemory)
          setMaxMemory(
            Math.min(
              16,
              Math.max(2, Math.round(settings.maxMemory / 1024) || 8),
            ),
          )
        if (settings.serverPort) setServerPort(settings.serverPort)
      } catch (error) {
        reportClientError('Failed to load settings.', error)
      }
    }
    loadSettings()
  }, [])

  useEffect(() => {
    const fetchBranches = async () => {
      setLoadingBranches(true)
      try {
        const data = await serverApi.getBranches(steamCmdPath)
        if (data.branches && Array.isArray(data.branches)) {
          setAvailableBranches(data.branches)
          if (!data.branches.find((b: { name: string }) => b.name === branch)) {
            setBranch('public')
          }
        }
      } catch (error) {
        reportClientError('Failed to fetch branches.', error)
      } finally {
        setLoadingBranches(false)
      }
    }

    if (hasSteamCmd && steamCmdPath) {
      fetchBranches()
    }
  }, [hasSteamCmd, steamCmdPath]) // eslint-disable-line react-hooks/exhaustive-deps -- branch intentionally excluded; setBranch('public') inside is a deliberate fallback, not a dep

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  useEffect(() => {
    if (!socket) return

    const handleInstallLog = (data: {
      type: 'stdout' | 'stderr'
      text: string
      progressCode?: string
      params?: Record<string, string | number>
    }) => {
      const text = data.text.trim()
      const displayText = getInstallProgressMessage(data, text)
      setLogs((prev) => [
        ...prev,
        { type: data.type, message: displayText, timestamp: new Date() },
      ])

      const progressMatch = text.match(
        /progress:\s*([\d.]+)\s*\(([\d,]+)\s*\/\s*([\d,]+)\)/,
      )
      if (progressMatch) {
        const percent = parseFloat(progressMatch[1])
        const downloaded = formatBytes(
          parseInt(progressMatch[2].replace(/,/g, '')),
        )
        const total = formatBytes(parseInt(progressMatch[3].replace(/,/g, '')))
        setInstallProgress({
          percent,
          downloaded,
          total,
          status: 'Downloading...',
        })
      }
      const validateMatch = text.match(/[Vv]alidat\w*[^\d]*(\d+)%/)
      if (validateMatch) {
        setInstallProgress({
          percent: parseInt(validateMatch[1]),
          downloaded: '',
          total: '',
          status: 'Validating files...',
        })
      }
      if (text.includes('Update state') && text.includes('verifying')) {
        setInstallProgress((prev) =>
          prev ? { ...prev, status: 'Verifying installation...' } : null,
        )
      }
      if (text.includes('Success!') || text.includes('fully installed')) {
        setInstallProgress({
          percent: 100,
          downloaded: '',
          total: '',
          status: 'Complete!',
        })
      }
    }

    const handleInstallComplete = async (data: {
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
      progressCode?: string
      params?: Record<string, string | number>
      warnings?: Array<{
        progressCode?: string
        message: string
        params?: Record<string, string | number>
      }>
    }) => {
      clearInstallInFlightMarker()
      const displayMessage = getInstallProgressMessage(data, data.message)
      try {
        installViaSteamCmdRef.current = false
        if (data.success) {
          setLogs((prev) => [
            ...prev,
            { type: 'success', message: displayMessage, timestamp: new Date() },
            ...(data.warnings ?? []).map((w) => ({
              type: 'warning' as const,
              message: getInstallProgressMessage(
                { progressCode: w.progressCode, params: w.params },
                w.message,
              ),
              timestamp: new Date(),
            })),
          ])

          const s = formStateRef.current
          let createResult: Awaited<ReturnType<typeof serversApi.create>>
          try {
            createResult = await serversApi.create({
              name: data.serverName || s.serverName,
              serverName: data.serverName || s.serverName,
              installPath: data.installPath || s.installPath,
              zomboidDataPath: data.zomboidDataPath || null,
              serverConfigPath: data.serverConfigPath || null,
              branch: data.branch,
              rconHost: '127.0.0.1',
              rconPort: data.rconPort || s.rconPort,
              rconPassword: data.rconPassword || s.rconPassword,
              adminPassword: s.adminPassword,
              serverPort: data.serverPort || s.serverPort,
              minMemory: (data.minMemory || s.minMemory) * 1024,
              maxMemory: (data.maxMemory || s.maxMemory) * 1024,
              useNoSteam: s.useNoSteam,
              useDebug: s.useDebug,
              useUpnp: s.useUpnp,
            })
            setLogs((prev) => [
              ...prev,
              {
                type: 'success',
                message: 'Server registered in panel database',
                timestamp: new Date(),
              },
            ])
          } catch (error) {
            reportClientError('Failed to create server entry.', error)
            setLogs((prev) => [
              ...prev,
              {
                type: 'error',
                message: 'Warning: Failed to register server in panel.',
                timestamp: new Date(),
              },
            ])
            toast({
              title: 'Server files installed, but registration failed',
              description:
                "The game files are on disk, but the panel couldn't add this server to its database, so it won't appear in My Servers yet. Check the log above, then try Server Setup again — it's safe to re-run.",
              variant: 'destructive',
            })
            return
          }

          if (createResult.server?.id) {
            try {
              await serversApi.activate(createResult.server.id)
              setLogs((prev) => [
                ...prev,
                {
                  type: 'success',
                  message: 'Switched active server to new installation',
                  timestamp: new Date(),
                },
              ])
            } catch (error) {
              reportClientError(
                'Failed to activate newly created server.',
                error,
              )
              setLogs((prev) => [
                ...prev,
                {
                  type: 'error',
                  message:
                    "Warning: Server was registered, but couldn't be set as the active server.",
                  timestamp: new Date(),
                },
              ])
              toast({
                title: 'Server registered, but not set active',
                description:
                  "The server was added to My Servers, but the panel couldn't switch to it automatically. Go to My Servers and select it manually before starting it.",
                variant: 'destructive',
              })
              return
            }
          }

          setInstallComplete(true)
          toast({
            title: 'Server Installed',
            description:
              'Project Zomboid server files were installed successfully.',
          })
        } else {
          setInstallComplete(false)
          setLogs((prev) => [
            ...prev,
            { type: 'error', message: displayMessage, timestamp: new Date() },
          ])
          toast({
            title: 'Installation Failed',
            description: displayMessage,
            variant: 'destructive',
          })
        }
      } finally {
        setInstalling(false)
      }
    }

    socket.on('install:log', handleInstallLog)
    socket.on('install:complete', handleInstallComplete)

    const handleSteamCmdStatus = (data: {
      status: string
      message: string
      path?: string
      progressCode?: string
      params?: Record<string, string | number>
    }) => {
      const displayMessage = getInstallProgressMessage(data, data.message)
      setSteamCmdStatus(displayMessage)
      if (installViaSteamCmdRef.current) {
        addLog(
          data.status === 'complete'
            ? 'success'
            : data.status === 'error'
              ? 'error'
              : 'info',
          displayMessage,
        )
      }
      if (data.status === 'complete' && data.path) {
        setSteamCmdPath(data.path)
        setHasSteamCmd(true)
        setDownloadingSteamCmd(false)
        toast({
          title: 'SteamCMD Ready',
          description: 'SteamCMD is installed and ready to use.',
        })
      } else if (data.status === 'error') {
        setDownloadingSteamCmd(false)
        toast({
          title: 'SteamCMD Setup Failed',
          description: displayMessage,
          variant: 'destructive',
        })
      }
    }

    const handleSteamCmdLog = (data: {
      type: string
      text: string
      progressCode?: string
      params?: Record<string, string | number>
    }) => {
      setSteamCmdStatus(getInstallProgressMessage(data, data.text.trim()))
      if (installViaSteamCmdRef.current) {
        addLog(
          data.type === 'stderr' ? 'stderr' : 'stdout',
          getInstallProgressMessage(data, data.text.trim()),
        )
      }
    }

    socket.on('steamcmd:status', handleSteamCmdStatus)
    socket.on('steamcmd:log', handleSteamCmdLog)

    return () => {
      socket.off('install:log', handleInstallLog)
      socket.off('install:complete', handleInstallComplete)
      socket.off('steamcmd:status', handleSteamCmdStatus)
      socket.off('steamcmd:log', handleSteamCmdLog)
    }
  }, [socket, toast])

  const addLog = (type: InstallLog['type'], message: string) => {
    setLogs((prev) => [...prev, { type, message, timestamp: new Date() }])
  }

  const handleAutoDownloadSteamCmd = async () => {
    setDownloadingSteamCmd(true)
    setSteamCmdStatus('Starting download...')
    try {
      await serverApi.downloadSteamCmd(steamCmdPath)
    } catch (error) {
      setDownloadingSteamCmd(false)
      toast({
        title: 'Download Failed',
        description: getUserErrorMessage(
          error,
          'Failed to start SteamCMD download.',
        ),
        variant: 'destructive',
      })
    }
  }

  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseSetter, setBrowseSetter] = useState<{
    fn: (path: string) => void
    title: string
    initial?: string
  } | null>(null)

  const handleBrowseFolder = (
    setter: (path: string) => void,
    description: string,
    currentPath?: string,
  ) => {
    setBrowseSetter({ fn: setter, title: description, initial: currentPath })
    setBrowseOpen(true)
  }

  const handleAutoDetectRam = async () => {
    setDetectingRam(true)
    try {
      const data = await debugApi.getRam()
      setSystemRam({
        totalGB: data.totalGB,
        freeGB: data.freeGB,
        recommendedMin: data.recommendedMin,
        recommendedMax: data.recommendedMax,
      })
      setMinMemory(data.recommendedMin)
      setMaxMemory(data.recommendedMax)
    } catch {
      // Silent fail - defaults are fine
    } finally {
      setDetectingRam(false)
    }
  }

  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleCopyPassword = () => {
    copyText(rconPassword)
    setCopiedPassword(true)
    toast({
      title: 'Password Copied',
      description: 'RCON password copied to clipboard.',
    })
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    copyTimeoutRef.current = setTimeout(() => setCopiedPassword(false), 2000)
  }

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    },
    [],
  )

  const handleRegeneratePassword = () => {
    setRconPassword(generatePassword(12))
    toast({
      title: 'Password Generated',
      description: 'A new RCON password has been generated.',
    })
  }

  const handleInstall = async () => {
    if (!adminPassword) {
      toast({
        title: 'Admin Password Required',
        description: 'Enter an admin password before starting installation.',
        variant: 'destructive',
      })
      return
    }
    if (!isValidGamePort(serverPort) || !isValidInstallPort(rconPort)) {
      toast({
        title: 'Invalid Port',
        description:
          'Game port must be a whole number between 1024 and 65534; RCON port must be between 1024 and 65535.',
        variant: 'destructive',
      })
      return
    }
    setInstalling(true)
    installViaSteamCmdRef.current = true
    setLogs([])
    setInstallProgress(null)
    addLog('info', 'Starting installation...')

    try {
      await serverApi.install({
        steamcmdPath: steamCmdPath,
        installPath,
        serverName,
        branch,
        zomboidDataPath: useCustomDataPath ? zomboidDataPath : null,
        minMemory,
        maxMemory,
        adminPassword: adminPassword || null,
        serverPort,
        useUpnp,
        useNoSteam,
        useDebug,
        rconPassword,
        rconPort,
      })
      writeInstallInFlightMarker({
        installPath,
        serverName,
        startedAt: Date.now(),
      })
    } catch (error) {
      installViaSteamCmdRef.current = false
      const rawMessage = rawErrorMessageIntentional(error, 'Unknown error')
      const displayMessage = getUserErrorMessage(error, 'Unknown error')
      const msg = installationErrorGuidance(
        rawMessage,
        displayMessage,
        serverPlatform,
      )
      addLog('error', msg)
      setInstalling(false)
      toast({
        title: 'Installation Failed',
        description: msg,
        variant: 'destructive',
      })
    }
  }

  const handleQuickSetup = async () => {
    if (!adminPassword) {
      toast({
        title: 'Admin Password Required',
        description: 'Enter an admin password before creating this server.',
        variant: 'destructive',
      })
      return
    }
    if (!isValidGamePort(serverPort) || !isValidInstallPort(rconPort)) {
      toast({
        title: 'Invalid Port',
        description:
          'Game port must be a whole number between 1024 and 65534; RCON port must be between 1024 and 65535.',
        variant: 'destructive',
      })
      return
    }
    setInstalling(true)
    setInstallComplete(false)
    setLogs([])
    addLog('info', 'Creating server configuration...')

    try {
      const data = await serverApi.quickSetup({
        installPath,
        serverName,
        zomboidDataPath: useCustomDataPath ? zomboidDataPath : null,
        minMemory,
        maxMemory,
        adminPassword: adminPassword || null,
        serverPort,
        useUpnp,
        useNoSteam,
        useDebug,
        rconPassword,
        rconPort,
      })

      if (data) {
        addLog('success', 'Server configuration created successfully!')
        for (const w of (data.warnings ?? []) as Array<{
          progressCode?: string
          message: string
          params?: Record<string, string | number>
        }>) {
          addLog(
            'warning',
            getInstallProgressMessage(
              { progressCode: w.progressCode, params: w.params },
              w.message,
            ),
          )
        }

        let createResult: Awaited<ReturnType<typeof serversApi.create>>
        try {
          createResult = await serversApi.create({
            name: data.serverName || serverName,
            serverName: data.serverName || serverName,
            installPath: data.installPath || installPath,
            zomboidDataPath: data.zomboidDataPath || null,
            serverConfigPath: data.serverConfigPath || null,
            rconHost: '127.0.0.1',
            rconPort: data.rconPort || rconPort,
            rconPassword: data.rconPassword || rconPassword,
            adminPassword,
            serverPort: data.serverPort || serverPort,
            minMemory: (data.minMemory || minMemory) * 1024,
            maxMemory: (data.maxMemory || maxMemory) * 1024,
            useNoSteam: useNoSteam,
            useDebug: useDebug,
            useUpnp: useUpnp,
          })
          addLog('success', 'Server registered in panel database')
        } catch (error) {
          reportClientError('Failed to create server entry.', error)
          addLog('error', 'Warning: Failed to register server in panel.')
          toast({
            title: 'Server files installed, but registration failed',
            description:
              "The game files are on disk, but the panel couldn't add this server to its database, so it won't appear in My Servers yet. Check the log above, then try Server Setup again — it's safe to re-run.",
            variant: 'destructive',
          })
          return
        }

        if (createResult.server?.id) {
          try {
            await serversApi.activate(createResult.server.id)
            addLog('success', 'Switched active server to new installation')
          } catch (error) {
            reportClientError('Failed to activate newly created server.', error)
            addLog(
              'error',
              "Warning: Server was registered, but couldn't be set as the active server.",
            )
            toast({
              title: 'Server registered, but not set active',
              description:
                "The server was added to My Servers, but the panel couldn't switch to it automatically. Go to My Servers and select it manually before starting it.",
              variant: 'destructive',
            })
            return
          }
        }

        setInstallComplete(true)
        toast({
          title: 'Server Added',
          description: 'Server configuration was created successfully.',
        })
      } else {
        addLog('error', data.error)
        toast({
          title: 'Setup Failed',
          description: data.error,
          variant: 'destructive',
        })
      }
    } catch (error) {
      const msg = getUserErrorMessage(
        error,
        'Unexpected error while creating server.',
      )
      addLog('error', msg)
      toast({
        title: 'Setup Failed',
        description: msg,
        variant: 'destructive',
      })
    } finally {
      setInstalling(false)
    }
  }

  const handleSaveSteamCmdPath = async () => {
    try {
      await configApi.updateAppSettings({ steamcmdPath: steamCmdPath })
      setHasSteamCmd(true)
      toast({
        title: 'Path Saved',
        description: 'SteamCMD path saved successfully.',
      })
    } catch {
      toast({
        title: 'Save Failed',
        description: 'Could not save SteamCMD path.',
        variant: 'destructive',
      })
    }
  }

  const handleStartServerNow = async () => {
    setStartingServer(true)
    try {
      await serverApi.start()
      toast({
        title: 'Server Starting',
        description: 'Redirecting to the dashboard...',
      })
      navigateTimerRef.current = setTimeout(
        () => void navigate({ to: '/' }),
        2000,
      )
    } catch (error) {
      toast({
        title: 'Start Failed',
        description: getUserErrorMessage(error, 'Unknown error'),
        variant: 'destructive',
      })
    } finally {
      setStartingServer(false)
    }
  }

  const handleResumeContinue = () => {
    if (!resumeMarker) return
    setInstallPath(resumeMarker.installPath)
    setServerName(resumeMarker.serverName)
    setSetupMode('full')
    setCurrentStep(2)
    setResumeMarker(null)
  }

  const handleResumeDismiss = () => {
    clearInstallInFlightMarker()
    setResumeMarker(null)
  }

  if (setupMode === 'select') {
    return (
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-primary"
              aria-hidden="true"
            />
            {'New Server'}
          </span>
          <h1 className="text-3xl font-bold">{'Server Setup'}</h1>
          <p className="text-muted-foreground text-base">
            {'Choose how you want to bring a Project Zomboid server online.'}
          </p>
        </div>

        {resumeMarker && (
          <Alert variant="warning" className="text-start">
            <AlertTriangle className="w-4 h-4" />
            <AlertTitle>{'An install may still be running'}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {'A previous session started installing to ' +
                  String(resumeMarker.installPath) +
                  ' (' +
                  String(
                    formatUptime(
                      Math.max(
                        0,
                        Math.floor(
                          (Date.now() - resumeMarker.startedAt) / 1000,
                        ),
                      ),
                    ),
                  ) +
                  ' ago) and the page was closed or reloaded before it finished. It may still be downloading in the background.'}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleResumeContinue}>
                  {'Continue setup'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleResumeDismiss}
                >
                  {'Dismiss'}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          {(() => {
            const activate = () => {
              setSetupMode('full')
              setCurrentStep(1)
            }

            return (
              <Card
                role="button"
                tabIndex={0}
                aria-describedby="full-setup-description"
                className="group relative overflow-hidden cursor-pointer border-primary/35 bg-gradient-to-br from-primary/[0.06] via-card to-card ring-1 ring-primary/15 transition-[border-color,box-shadow,transform] hover:border-primary/55 hover:ring-primary/25 hover:shadow-lg hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={activate}
                onKeyDown={(event) => handleCardKeyDown(event, activate)}
              >
                <div
                  className="absolute top-0 inset-x-0 h-[3px] bg-gradient-to-r from-primary via-primary/80 to-primary/40"
                  aria-hidden="true"
                />
                <div className="absolute right-3 top-3">
                  <Badge
                    variant="secondary"
                    className="text-[10px] font-medium uppercase tracking-wide"
                  >
                    {'Recommended'}
                  </Badge>
                </div>
                <CardHeader className="pb-3">
                  <div className="grid place-items-center w-11 h-11 rounded-md border border-primary/30 bg-primary/[0.08] text-primary mb-3 transition-colors group-hover:bg-primary/15">
                    <Download className="w-5 h-5" />
                  </div>
                  <CardTitle className="text-lg">{'Fresh Install'}</CardTitle>
                  <CardDescription
                    id="full-setup-description"
                    className="text-xs"
                  >
                    {
                      'Download and configure a new dedicated server from scratch'
                    }
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pb-5">
                  <ul className="space-y-1.5 text-[13px]">
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>
                        {'Downloads server files via SteamCMD'}{' '}
                        <span className="text-foreground/60">{'(~3 GB)'}</span>
                      </span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>{'Choose game version branch'}</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>
                        {'Generates config and startup files automatically'}
                      </span>
                    </li>
                  </ul>
                  <div className="flex items-center gap-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-primary/90">
                    {'Begin install'}{' '}
                    <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </CardContent>
              </Card>
            )
          })()}

          {(() => {
            const activate = () => {
              setSetupMode('quick')
              setCurrentStep(1)
            }

            return (
              <Card
                role="button"
                tabIndex={0}
                aria-describedby="quick-setup-description"
                className="group relative overflow-hidden cursor-pointer border-border/60 bg-card transition-[border-color,box-shadow,transform] hover:border-primary/40 hover:shadow-md hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={activate}
                onKeyDown={(event) => handleCardKeyDown(event, activate)}
              >
                <CardHeader className="pb-3">
                  <div className="grid place-items-center w-11 h-11 rounded-md border border-border/55 bg-muted/40 text-muted-foreground mb-3 transition-colors group-hover:border-primary/30 group-hover:bg-primary/[0.06] group-hover:text-primary">
                    <Plus className="w-5 h-5" />
                  </div>
                  <CardTitle className="text-lg">
                    {'Use Existing Files'}
                  </CardTitle>
                  <CardDescription
                    id="quick-setup-description"
                    className="text-xs"
                  >
                    {'Register a server using files you already downloaded'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pb-5">
                  <ul className="space-y-1.5 text-[13px]">
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>{'No download required'}</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>{'Point to an existing PZ server folder'}</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>{'Fast 3-step setup'}</span>
                    </li>
                  </ul>
                  <div className="flex items-center gap-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors group-hover:text-primary/90">
                    {'Register server'}{' '}
                    <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </CardContent>
              </Card>
            )
          })()}
        </div>

        <Card className="bg-secondary/40 border-border/70 shadow-sm">
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg border border-primary/20 bg-primary/10 flex items-center justify-center shrink-0">
                <Info className="w-5 h-5 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="font-medium">{'Not sure which to choose?'}</p>
                <p className="text-sm text-muted-foreground">
                  <>
                    {
                      "If you've never set up a Project Zomboid server before, choose "
                    }
                    <strong>{'Fresh Install'}</strong>
                    {'. It will download everything you need automatically.'}
                  </>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const renderStepIndicator = () => {
    const steps =
      setupMode === 'quick'
        ? [
            { id: 1, label: 'Location', icon: HardDrive },
            { id: 2, label: 'Configure', icon: Settings2 },
            { id: 3, label: 'Create', icon: Plus },
          ]
        : [
            { id: 1, label: 'SteamCMD', icon: Download },
            { id: 2, label: 'Server', icon: Server },
            { id: 3, label: 'Settings', icon: Settings2 },
            { id: 4, label: 'Install', icon: Zap },
          ]

    return (
      <div className="flex items-center justify-center mb-8">
        <div className="flex items-center gap-0">
          {steps.map((step, index) => {
            const Icon = step.icon
            const isActive = currentStep === step.id
            const isComplete = currentStep > step.id
            const isClickable =
              step.id <= currentStep ||
              stepValidation[step.id as keyof typeof stepValidation]

            return (
              <div key={step.id} className="flex items-center">
                <button
                  onClick={() => isClickable && setCurrentStep(step.id)}
                  disabled={!isClickable}
                  aria-current={isActive ? 'step' : undefined}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 sm:px-3.5 sm:py-2 rounded-full border transition-colors',
                    isActive &&
                      'border-primary bg-primary text-primary-foreground shadow-sm',
                    !isActive &&
                      isComplete &&
                      'border-primary/40 bg-primary/[0.08] text-primary',
                    !isActive &&
                      !isComplete &&
                      'border-border/50 bg-muted/30 text-muted-foreground',
                    isClickable &&
                      !isActive &&
                      'hover:border-primary/40 hover:bg-muted/60 cursor-pointer',
                  )}
                >
                  {isComplete ? (
                    <CheckCircle className="w-4 h-4" />
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                  <span className="text-[11px] font-medium uppercase tracking-wide hidden sm:inline">
                    {step.label}
                  </span>
                </button>
                {index < steps.length - 1 && (
                  <span
                    className={cn(
                      'w-6 sm:w-10 h-px mx-1',
                      isComplete ? 'bg-primary/50' : 'bg-border/60',
                    )}
                    aria-hidden="true"
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const renderFullStep1 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{'Set Up SteamCMD'}</h2>
        <p className="text-muted-foreground">
          {
            'SteamCMD is required to download and update Project Zomboid dedicated server files.'
          }
        </p>
      </div>

      {!hasSteamCmd ? (
        <div className="space-y-6">
          <Card className="border-primary/35 bg-card shadow-sm">
            <CardContent className="pt-6">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
                  <Sparkles className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1 space-y-4">
                  <div>
                    <h3 className="font-semibold text-lg">
                      {'One-Click Setup'}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {
                        'We will install SteamCMD and prepare it for this panel.'
                      }
                    </p>
                  </div>

                  <div className="flex gap-2 items-center">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder={'Select or enter the SteamCMD folder path'}
                      className="font-mono flex-1"
                      disabled={downloadingSteamCmd}
                      maxLength={260}
                    />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() =>
                              handleBrowseFolder(
                                setSteamCmdPath,
                                'Select SteamCMD folder',
                                steamCmdPath,
                              )
                            }
                            disabled={downloadingSteamCmd}
                            aria-label={'Browse SteamCMD folder'}
                          >
                            <FolderOpen className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{'Browse folder'}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>

                  <Button
                    onClick={handleAutoDownloadSteamCmd}
                    disabled={downloadingSteamCmd}
                    className="w-full"
                    size="lg"
                  >
                    {downloadingSteamCmd ? (
                      <>
                        <Loader2 className="w-4 h-4 me-2 animate-spin" />
                        {steamCmdStatus || 'Installing SteamCMD...'}
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4 me-2" />
                        {'Install SteamCMD Automatically'}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Accordion type="single" collapsible className="border rounded-lg">
            <AccordionItem value="manual" className="border-0">
              <AccordionTrigger className="px-4 hover:no-underline">
                <div className="flex items-center gap-2">
                  <Settings2 className="w-4 h-4" />
                  <span>
                    {'Already have SteamCMD? Set the folder manually'}
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="space-y-4">
                  <div className="bg-warning/10 border border-warning/40 rounded-lg p-4 text-sm shadow-sm">
                    <p className="font-medium text-warning">{'Manual Setup'}</p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground mt-2">
                      <li>{'Download SteamCMD from Valve'}</li>
                      <li>
                        Extract SteamCMD to a folder such as{' '}
                        <code className="bg-muted px-1 rounded">
                          {runtimeInfo?.family === 'windows'
                            ? 'C:\\SteamCMD'
                            : '~/steamcmd'}
                        </code>
                        .
                      </li>
                      <li>
                        <>
                          {'Run '}
                          <code className="bg-muted px-1 rounded">
                            {'steamcmd'}
                          </code>
                          {' once so it can self-update'}
                        </>
                      </li>
                    </ol>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() =>
                        window.open(
                          'https://developer.valvesoftware.com/wiki/SteamCMD#Downloading_SteamCMD',
                          '_blank',
                        )
                      }
                    >
                      <Download className="w-4 h-4 me-2" />
                      {'Download SteamCMD'}
                      <ExternalLink className="w-3 h-3 ms-2" />
                    </Button>
                  </div>

                  <div className="flex gap-2">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder={'Path to your existing SteamCMD folder'}
                      className="font-mono flex-1"
                      maxLength={260}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        handleBrowseFolder(
                          setSteamCmdPath,
                          'Select SteamCMD folder',
                          steamCmdPath,
                        )
                      }
                      aria-label={'Browse SteamCMD folder'}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>

                    <Button onClick={handleSaveSteamCmdPath}>
                      {'Save Path'}
                    </Button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      ) : (
        <Card className="border-primary/30 bg-card shadow-sm">
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl border border-primary/25 bg-primary/14 flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <p className="font-semibold">{'SteamCMD Ready'}</p>
                <p className="text-sm text-muted-foreground font-mono">
                  {steamCmdPath}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHasSteamCmd(false)}
              >
                {'Change Path'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )

  const renderFullStep2 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{'Server Details'}</h2>
        <p className="text-muted-foreground">
          {'Choose where files are installed and set the server identity.'}
        </p>
      </div>

      <div className="grid gap-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <Label className="text-base">{'Install Folder'}</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-0 text-xs"
              onClick={() => setInstallPath(LINUX_SERVICE_INSTALL_PATH)}
            >
              {'Use Linux service path'}
            </Button>
          </div>
          <div className="flex gap-2">
            <Input
              value={installPath}
              onChange={(e) => setInstallPath(e.target.value)}
              placeholder={
                runtimeInfo?.family === 'windows'
                  ? 'e.g. C:\\PZServer'
                  : runtimeInfo?.family === 'posix'
                    ? 'e.g. /home/steamuser/pzserver'
                    : 'Path to the dedicated server folder'
              }
              className="font-mono flex-1"
              maxLength={260}
            />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      handleBrowseFolder(
                        setInstallPath,
                        'Select server folder',
                        installPath,
                      )
                    }
                    aria-label={'Browse install folder'}
                  >
                    <FolderOpen className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{'Browse folder'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-xs text-muted-foreground">
            {
              "SteamCMD downloads about 3 GB of server files into this folder, creating it automatically if it doesn't exist yet — the panel just needs permission to write here. This is separate from where saves and settings are stored; see Custom config location below."
            }
          </p>
        </div>

        <div className="border border-border/60 bg-muted/40 rounded-lg p-4 text-sm space-y-2">
          <p className="font-medium flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            {'Linux service installs'}
          </p>
          <p className="text-muted-foreground">
            <>
              {'If the panel runs through the bundled systemd service, use '}
              <code className="bg-muted px-1 rounded">
                {LINUX_SERVICE_INSTALL_PATH}
              </code>
              {'. Other folders require a systemd permission change.'}
            </>
          </p>
          <p className="text-muted-foreground">
            <>
              {'The server data folder is created beside the install folder: '}
              <code className="bg-muted px-1 rounded break-all">
                {installPath.trim()
                  ? `${installPath.trim()}_Data`
                  : 'your-install-folder_Data'}
              </code>
              {'. Both folders must be writable.'}
            </>
          </p>
        </div>

        <div className="space-y-2">
          <Label className="text-base">{'Server Name'}</Label>
          <Input
            value={serverName}
            onChange={(e) =>
              setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))
            }
            placeholder={'myserver'}
            className="font-mono"
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">
            {
              'Alphanumeric characters and underscores only, e.g. myserver. This becomes the config file name (myserver.ini) — set it before installing. Changing it afterward creates a new, empty config instead of renaming the existing one.'
            }
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Label className="text-base">{'Game Version'}</Label>
            <HelpTip label={'Game Version'}>
              {
                "Most people want Stable — it's the current default build. The other branches Steam offers here are older or experimental builds, kept around for compatibility with mods or saves that haven't updated yet. Saves and mods aren't guaranteed to work across different builds, so only switch if you specifically need one."
              }
            </HelpTip>
          </div>
          <Select
            value={branch}
            onValueChange={setBranch}
            disabled={loadingBranches}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  loadingBranches
                    ? 'Loading available versions...'
                    : 'Select game version'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {availableBranches.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  <div className="flex flex-col">
                    <span>
                      {b.name === 'public'
                        ? 'Build 42 (Stable)'
                        : b.description || b.name}
                    </span>
                    {b.buildId && (
                      <span className="text-xs text-muted-foreground">
                        {'Build: ' + String(b.buildId)}
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Accordion type="single" collapsible className="border rounded-lg">
          <AccordionItem value="datapath" className="border-0">
            <AccordionTrigger className="px-4 hover:no-underline">
              <div className="flex items-center gap-2 text-sm">
                <FolderOpen className="w-4 h-4" />
                <span>{'Custom config location'}</span>
                {useCustomDataPath && zomboidDataPath && (
                  <Badge variant="secondary" className="ms-2">
                    {'Set'}
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {
                    'Leave this blank to create a data folder beside the install folder. In Docker, choose a bind-mounted folder when overriding it.'
                  }
                </p>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={useCustomDataPath}
                    onCheckedChange={setUseCustomDataPath}
                  />
                  <Label>{'Use custom location'}</Label>
                </div>
                {useCustomDataPath && (
                  <>
                    <div className="flex gap-2">
                      <Input
                        value={zomboidDataPath}
                        onChange={(e) => setZomboidDataPath(e.target.value)}
                        placeholder={
                          runtimeInfo?.family === 'windows'
                            ? 'e.g. C:\\Users\\you\\Zomboid or %USERPROFILE%\\Zomboid'
                            : runtimeInfo?.family === 'posix'
                              ? 'e.g. /home/you/Zomboid or $HOME/Zomboid'
                              : 'Path to the Zomboid data folder'
                        }
                        className="font-mono flex-1"
                        maxLength={260}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          handleBrowseFolder(
                            setZomboidDataPath,
                            'Select config folder',
                            zomboidDataPath,
                          )
                        }
                        aria-label={'Browse config folder'}
                      >
                        <FolderOpen className="w-4 h-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {
                        "Project Zomboid normally stores saves, server config, and logs beside the install folder. Only set this if that data actually lives somewhere else — for example a separate drive, or a bind-mounted folder in Docker. Point this at the wrong folder and the panel won't find your existing saves, settings, or backups."
                      }
                    </p>
                  </>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  )

  const renderFullStep3 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{'Server Settings'}</h2>
        <p className="text-muted-foreground">
          {'Configure remote control access and runtime options.'}
        </p>
      </div>

      <Card className="border-primary/35 bg-card shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">{'Remote Control (RCON)'}</CardTitle>
            <Badge className="ms-auto">{'Required'}</Badge>
          </div>
          <CardDescription>
            {'This panel uses RCON to run commands on your server.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label>{'RCON Password'}</Label>
                <HelpTip label={'RCON Password'}>
                  {
                    "RCON is the remote-console protocol this panel uses to send commands to the running game — kicking players, saving the world, broadcasting messages, and everything else the panel does. This password is generated for you and the panel remembers it automatically. If you ever change it in the server's own settings later, update it here too, or the panel loses control of the server."
                  }
                </HelpTip>
              </div>
              <div className="flex gap-1">
                <div className="relative flex-1">
                  <Input
                    type={showRconPassword ? 'text' : 'password'}
                    value={rconPassword}
                    onChange={(e) => setRconPassword(e.target.value)}
                    className="pe-10 font-mono"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 h-9 w-9 p-0"
                    onClick={() => setShowRconPassword(!showRconPassword)}
                    aria-label={
                      showRconPassword
                        ? 'Hide RCON password'
                        : 'Show RCON password'
                    }
                  >
                    {showRconPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleCopyPassword}
                        aria-label={'Copy password'}
                      >
                        {copiedPassword ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{'Copy password'}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleRegeneratePassword}
                        aria-label={'Generate new password'}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{'Generate new password'}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {rconPassword.length > 0 && rconPassword.length < 6 && (
                <p className="text-xs text-destructive">
                  {'Minimum 6 characters'}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label>{'RCON Port'}</Label>
                <HelpTip label={'RCON Port'}>
                  {
                    'The port the panel uses to send RCON commands (start, stop, save, kick, chat) to the running server — separate from the port players connect on. Example: 27015 (the default). It must be free on this machine; if another program is already using it, the server may fail to start, or the panel may not be able to connect and control it.'
                  }
                </HelpTip>
              </div>
              <NumberInput
                min={1024}
                max={65535}
                value={rconPort}
                onChange={setRconPort}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {'Default port: 27015'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-primary/35 bg-card shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">{'Admin Password'}</CardTitle>
            <Badge className="ms-auto">{'Required'}</Badge>
          </div>
          <CardDescription>
            {
              "Sets the password for Project Zomboid's built-in admin account. Once the server is running, use it in-game with the chat command /login admin, followed by this password, to get admin powers. Required before the first server start — the server can be installed without it, but won't start until one is set."
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative max-w-sm">
            <Input
              type={showAdminPassword ? 'text' : 'password'}
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              placeholder={'Required before first server start'}
              className="pe-10"
              maxLength={128}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-1 top-1 h-9 w-9 p-0"
              onClick={() => setShowAdminPassword(!showAdminPassword)}
              aria-label={
                showAdminPassword
                  ? 'Hide admin password'
                  : 'Show admin password'
              }
            >
              {showAdminPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5" />
              <CardTitle className="text-lg">{'Memory Allocation'}</CardTitle>
            </div>
            {detectingRam ? (
              <Badge variant="outline" className="animate-pulse">
                {'Detecting RAM...'}
              </Badge>
            ) : (
              systemRam && (
                <Badge variant="outline">
                  {String(systemRam.totalGB) + ' GB RAM detected'}
                </Badge>
              )
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Label>{'Minimum RAM'}</Label>
                  <HelpTip label={'Minimum RAM'}>
                    {
                      "Minimum is how much memory Project Zomboid reserves the moment it starts. Maximum is the hard ceiling it's allowed to grow to. Set Minimum too low and the server can stutter or crash once players and mods add up; set Maximum higher than the RAM this machine actually has and the server — or everything else running on it — can crash instead. Leave some headroom for the operating system."
                    }
                  </HelpTip>
                </div>
                <NumberInput
                  min={1}
                  max={64}
                  value={minMemory}
                  className="h-8 w-20 bg-background text-end font-mono"
                  clamp={(n) => Math.min(64, Math.max(1, n))}
                  onChange={(value) => {
                    setMinMemory(value)
                    if (value > maxMemory) setMaxMemory(value)
                  }}
                  aria-label={'Minimum RAM in GB'}
                />
              </div>
              <Slider
                value={[
                  Math.min(Number.isFinite(minMemory) ? minMemory : 1, 64),
                ]}
                onValueChange={([val]) => {
                  setMinMemory(val)
                  if (val > maxMemory) setMaxMemory(val)
                }}
                min={2}
                max={64}
                step={1}
                aria-label={'Minimum RAM: ' + String(minMemory) + 'GB'}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label>{'Maximum RAM'}</Label>
                <NumberInput
                  min={1}
                  max={128}
                  value={maxMemory}
                  className="h-8 w-20 bg-background text-end font-mono"
                  clamp={(n) => Math.min(128, Math.max(1, n))}
                  onChange={(value) => {
                    setMaxMemory(value)
                    if (value < minMemory) setMinMemory(value)
                  }}
                  aria-label={'Maximum RAM in GB'}
                />
              </div>
              <Slider
                value={[
                  Math.min(Number.isFinite(maxMemory) ? maxMemory : 1, 128),
                ]}
                onValueChange={([val]) => {
                  setMaxMemory(val)
                  if (val < minMemory) setMinMemory(val)
                }}
                min={2}
                max={128}
                step={1}
                aria-label={'Maximum RAM: ' + String(maxMemory) + 'GB'}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Accordion type="single" collapsible className="border rounded-lg">
        <AccordionItem value="advanced" className="border-0">
          <AccordionTrigger className="px-4 hover:no-underline">
            <div className="flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              <span>{'Advanced Options'}</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>{'Game Port'}</Label>
                  <HelpTip label={'Game Port'}>
                    {
                      'The port Project Zomboid game clients connect to when players join. Example: 16261 (the default). If you change it, players must add the new number after your server address to connect (e.g. your-ip:16262), and your router or firewall must forward that same port instead.'
                    }
                  </HelpTip>
                </div>
                <NumberInput
                  min={1024}
                  max={65534}
                  value={serverPort}
                  onChange={setServerPort}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {'Default port: 16261'}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{'UPnP'}</p>
                  <p className="text-xs text-muted-foreground">
                    {'Attempt automatic router port forwarding'}
                  </p>
                </div>
                <Switch
                  checked={useUpnp}
                  onCheckedChange={setUseUpnp}
                  aria-label={'Enable UPnP'}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{'No Steam'}</p>
                  <p className="text-xs text-muted-foreground">
                    {'Use non-Steam mode (for GOG and LAN setups)'}
                  </p>
                </div>
                <Switch
                  checked={useNoSteam}
                  onCheckedChange={setUseNoSteam}
                  aria-label={'Enable no-Steam mode'}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{'Debug'}</p>
                  <p className="text-xs text-muted-foreground">
                    {'Enable verbose startup and runtime logs'}
                  </p>
                </div>
                <Switch
                  checked={useDebug}
                  onCheckedChange={setUseDebug}
                  aria-label={'Enable debug mode'}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )

  const renderFullStep4 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{'Review and Install'}</h2>
        <p className="text-muted-foreground">
          {'Confirm your settings, then begin the server download.'}
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between gap-3 py-2 border-b">
              <span className="text-muted-foreground shrink-0">
                {'Installation Path'}
              </span>
              <span
                className="font-mono text-end min-w-0 flex-1 truncate"
                title={installPath}
              >
                {installPath}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{'Server Name'}</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{'Game Version'}</span>
              <span>{branch === 'public' ? 'Build 42 (Stable)' : branch}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{'Memory'}</span>
              <span className="font-mono">
                {formatMemory(minMemory)}GB - {formatMemory(maxMemory)}GB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{'Game Port'}</span>
              <span className="font-mono">{formatPort(serverPort)}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">{'RCON Port'}</span>
              <span className="font-mono">{formatPort(rconPort)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="bg-muted/50 border border-border/60 rounded-lg p-4 text-sm shadow-sm">
        <p className="font-medium flex items-center gap-2">
          <Info className="w-4 h-4 text-primary" />
          {'Firewall / Port Forwarding'}
        </p>
        <p className="text-muted-foreground mt-1">
          {'Make sure your firewall or router allows:'}
        </p>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>
            •{' '}
            <code className="bg-muted px-1 rounded">
              {formatPort(serverPort)}
            </code>{' '}
            {'UDP - Game traffic'}
          </li>
          <li>
            •{' '}
            <code className="bg-muted px-1 rounded">
              {formatPort(serverPort + 1)}
            </code>{' '}
            {'UDP - Direct connect'}
          </li>
        </ul>
      </div>

      <Button
        onClick={handleInstall}
        disabled={installing || missingAdminPassword}
        className="w-full"
        size="lg"
      >
        {installing ? (
          <>
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
            {'Installing server... check the log below'}
          </>
        ) : (
          <>
            <Download className="w-4 h-4 me-2" />
            {'Install Project Zomboid Server'}
          </>
        )}
      </Button>

      {missingAdminPassword && (
        <p className="text-sm text-warning">
          {'Add an Admin Password in Advanced Options before installing.'}
        </p>
      )}

      {installing && installProgress && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {installProgress.status}
            </span>
            <span className="font-mono">
              {installProgress.percent.toFixed(0)}%
              {installProgress.downloaded && installProgress.total && (
                <span className="text-muted-foreground ms-2">
                  ({installProgress.downloaded} / {installProgress.total})
                </span>
              )}
            </span>
          </div>
          <Progress value={installProgress.percent} className="h-2" />
        </div>
      )}

      {logs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">{'Installation Log'}</span>
          </div>
          <ScrollArea className="h-[200px] bg-background rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    log.type === 'error' || log.type === 'stderr'
                      ? 'text-destructive'
                      : log.type === 'warning'
                        ? 'text-warning'
                        : log.type === 'success'
                          ? 'text-success'
                          : log.type === 'command'
                            ? 'text-primary'
                            : 'text-foreground/80',
                  )}
                >
                  {log.message}
                </div>
              ))}
              {installing && (
                <div className="text-muted-foreground animate-pulse">...</div>
              )}
              <div ref={logsEndRef} />
            </div>
          </ScrollArea>
        </div>
      )}

      {installComplete && (
        <Card className="border-primary/32 bg-card shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">{'Installation Complete'}</span>
            </div>

            <div className="bg-warning/10 border border-warning/40 rounded-lg p-4 text-sm shadow-sm">
              <p className="font-medium flex items-center gap-2 text-warning">
                <Info className="w-4 h-4" />
                {'First Start Required'}
              </p>
              <p className="text-muted-foreground mt-1">
                {
                  'Start the server once to generate configuration files and world data. The first startup can take up to a minute.'
                }
              </p>
            </div>

            <div className="flex gap-3">
              <Button
                onClick={handleStartServerNow}
                disabled={startingServer}
                className="flex-1"
              >
                {startingServer ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />{' '}
                    {'Starting...'}
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 me-2" /> {'Start Server'}
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                onClick={() => void navigate({ to: '/' })}
              >
                {'Open Dashboard'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )

  const renderQuickStep1 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{'Select Server Files'}</h2>
        <p className="text-muted-foreground">
          {'Choose the existing Project Zomboid dedicated server folder.'}
        </p>
      </div>

      <Card className="bg-secondary/40 border-primary/24 shadow-sm">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg border border-primary/20 bg-primary/10 flex items-center justify-center shrink-0">
              <HardDrive className="w-5 h-5 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">{'Using existing files'}</p>
              <p className="text-sm text-muted-foreground">
                The folder should contain{' '}
                <code className="bg-muted px-1 rounded">
                  {runtimeInfo?.family === 'windows'
                    ? 'StartServer64.bat'
                    : 'start-server.sh'}
                </code>{' '}
                and the <code className="bg-muted px-1 rounded">java</code>{' '}
                folder.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Label className="text-base">{'Server Files Location'}</Label>
        <div className="flex gap-2">
          <Input
            value={installPath}
            onChange={(e) => setInstallPath(e.target.value)}
            placeholder={'Path to your existing dedicated server folder'}
            className="font-mono flex-1"
            maxLength={260}
          />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() =>
                    handleBrowseFolder(
                      setInstallPath,
                      'Select PZ server folder',
                      installPath,
                    )
                  }
                  aria-label={'Browse server files folder'}
                >
                  <FolderOpen className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{'Browse folder'}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="text-xs text-muted-foreground">
          {
            'Folder that already contains your Project Zomboid dedicated server files.'
          }
        </p>
      </div>
    </div>
  )

  const renderQuickStep2 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{'Configure Server'}</h2>
        <p className="text-muted-foreground">
          {'Set server name, RCON access, and memory limits.'}
        </p>
      </div>

      <div className="grid gap-6">
        <div className="space-y-2">
          <Label className="text-base">{'Server Name'}</Label>
          <Input
            value={serverName}
            onChange={(e) =>
              setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))
            }
            placeholder={'myserver'}
            className="font-mono"
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">
            {
              'Alphanumeric characters and underscores only, e.g. myserver. Becomes the config file name (myserver.ini) for the existing server files you selected in the previous step.'
            }
          </p>
        </div>

        <Card className="border-primary/35 bg-card shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">
                {'Remote Control (RCON)'}
              </CardTitle>
              <Badge className="ms-auto">{'Required'}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>{'RCON Password'}</Label>
                  <HelpTip label={'RCON Password'}>
                    {
                      "RCON is the remote-console protocol this panel uses to send commands to the running game — kicking players, saving the world, broadcasting messages, and everything else the panel does. This password is generated for you and the panel remembers it automatically. If you ever change it in the server's own settings later, update it here too, or the panel loses control of the server."
                    }
                  </HelpTip>
                </div>
                <div className="flex gap-1">
                  <div className="relative flex-1">
                    <Input
                      type={showRconPassword ? 'text' : 'password'}
                      value={rconPassword}
                      onChange={(e) => setRconPassword(e.target.value)}
                      className="pe-10 font-mono"
                      maxLength={128}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1 h-9 w-9 p-0"
                      onClick={() => setShowRconPassword(!showRconPassword)}
                      aria-label={
                        showRconPassword
                          ? 'Hide RCON password'
                          : 'Show RCON password'
                      }
                    >
                      {showRconPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={handleCopyPassword}
                          aria-label={'Copy password'}
                        >
                          {copiedPassword ? (
                            <Check className="w-4 h-4" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{'Copy password'}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={handleRegeneratePassword}
                          aria-label={'Generate new password'}
                        >
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{'Generate new password'}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                {rconPassword.length > 0 && rconPassword.length < 6 && (
                  <p className="text-xs text-destructive">
                    {'Minimum 6 characters'}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>{'RCON Port'}</Label>
                  <HelpTip label={'RCON Port'}>
                    {
                      'The port the panel uses to send RCON commands (start, stop, save, kick, chat) to the running server — separate from the port players connect on. Example: 27015 (the default). It must be free on this machine; if another program is already using it, the server may fail to start, or the panel may not be able to connect and control it.'
                    }
                  </HelpTip>
                </div>
                <NumberInput
                  min={1024}
                  max={65535}
                  value={rconPort}
                  onChange={setRconPort}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {'Default port: 27015'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-primary/35 bg-card shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">{'Admin Password'}</CardTitle>
              <Badge className="ms-auto">{'Required'}</Badge>
            </div>
            <CardDescription>
              {
                "Sets the password for Project Zomboid's built-in admin account. Once the server is running, use it in-game with the chat command /login admin, followed by this password, to get admin powers. Required before the first server start — the server can be installed without it, but won't start until one is set."
              }
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative max-w-sm">
              <Input
                type={showAdminPassword ? 'text' : 'password'}
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder={'Required before first server start'}
                className="pe-10"
                maxLength={128}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1 h-9 w-9 p-0"
                onClick={() => setShowAdminPassword(!showAdminPassword)}
                aria-label={
                  showAdminPassword
                    ? 'Hide admin password'
                    : 'Show admin password'
                }
              >
                {showAdminPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-5 h-5" />
                <CardTitle className="text-lg">{'Memory Allocation'}</CardTitle>
              </div>
              {detectingRam ? (
                <Badge variant="outline" className="animate-pulse">
                  {'Detecting RAM...'}
                </Badge>
              ) : (
                systemRam && (
                  <Badge variant="outline">
                    {String(systemRam.totalGB) + ' GB detected'}
                  </Badge>
                )
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    <Label>{'Minimum RAM'}</Label>
                    <HelpTip label={'Minimum RAM'}>
                      {
                        "Minimum is how much memory Project Zomboid reserves the moment it starts. Maximum is the hard ceiling it's allowed to grow to. Set Minimum too low and the server can stutter or crash once players and mods add up; set Maximum higher than the RAM this machine actually has and the server — or everything else running on it — can crash instead. Leave some headroom for the operating system."
                      }
                    </HelpTip>
                  </div>
                  <NumberInput
                    min={1}
                    max={64}
                    value={minMemory}
                    className="h-8 w-20 bg-background text-end font-mono"
                    clamp={(n) => Math.min(64, Math.max(1, n))}
                    onChange={(value) => {
                      setMinMemory(value)
                      if (value > maxMemory) setMaxMemory(value)
                    }}
                    aria-label={'Minimum RAM in GB'}
                  />
                </div>
                <Slider
                  value={[
                    Math.min(Number.isFinite(minMemory) ? minMemory : 1, 64),
                  ]}
                  onValueChange={([val]) => {
                    setMinMemory(val)
                    if (val > maxMemory) setMaxMemory(val)
                  }}
                  min={2}
                  max={64}
                  step={1}
                  aria-label={'Minimum RAM: ' + String(minMemory) + 'GB'}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label>{'Maximum RAM'}</Label>
                  <NumberInput
                    min={1}
                    max={128}
                    value={maxMemory}
                    className="h-8 w-20 bg-background text-end font-mono"
                    clamp={(n) => Math.min(128, Math.max(1, n))}
                    onChange={(value) => {
                      setMaxMemory(value)
                      if (value < minMemory) setMinMemory(value)
                    }}
                    aria-label={'Maximum RAM in GB'}
                  />
                </div>
                <Slider
                  value={[
                    Math.min(Number.isFinite(maxMemory) ? maxMemory : 1, 128),
                  ]}
                  onValueChange={([val]) => {
                    setMaxMemory(val)
                    if (val < minMemory) setMinMemory(val)
                  }}
                  min={2}
                  max={128}
                  step={1}
                  aria-label={'Maximum RAM: ' + String(maxMemory) + 'GB'}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Accordion type="single" collapsible className="border rounded-lg">
          <AccordionItem value="advanced" className="border-0">
            <AccordionTrigger className="px-4 hover:no-underline">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4" />
                <span>{'Advanced Options'}</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4 space-y-4">
              <div className="flex items-center gap-3">
                <Switch
                  checked={useCustomDataPath}
                  onCheckedChange={setUseCustomDataPath}
                />
                <Label>{'Custom config location'}</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                {
                  'Leave this blank to create a data folder beside the install folder. In Docker, choose a bind-mounted folder when overriding it.'
                }
              </p>
              {useCustomDataPath && (
                <>
                  <div className="flex gap-2">
                    <Input
                      value={zomboidDataPath}
                      onChange={(e) => setZomboidDataPath(e.target.value)}
                      placeholder={
                        runtimeInfo?.family === 'windows'
                          ? 'e.g. C:\\Users\\you\\Zomboid or %USERPROFILE%\\Zomboid'
                          : runtimeInfo?.family === 'posix'
                            ? 'e.g. /home/you/Zomboid or $HOME/Zomboid'
                            : 'Path to the Zomboid data folder'
                      }
                      className="font-mono flex-1"
                      maxLength={260}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        handleBrowseFolder(
                          setZomboidDataPath,
                          'Select config folder',
                          zomboidDataPath,
                        )
                      }
                      aria-label={'Browse config folder'}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {
                      "Project Zomboid normally stores saves, server config, and logs beside the install folder. Only set this if that data actually lives somewhere else — for example a separate drive, or a bind-mounted folder in Docker. Point this at the wrong folder and the panel won't find your existing saves, settings, or backups."
                    }
                  </p>
                </>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>{'Game Port'}</Label>
                    <HelpTip label={'Game Port'}>
                      {
                        'The port Project Zomboid game clients connect to when players join. Example: 16261 (the default). If you change it, players must add the new number after your server address to connect (e.g. your-ip:16262), and your router or firewall must forward that same port instead.'
                      }
                    </HelpTip>
                  </div>
                  <NumberInput
                    min={1024}
                    max={65534}
                    value={serverPort}
                    onChange={setServerPort}
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    {'Default port: 16261'}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{'UPnP'}</p>
                    <p className="text-xs text-muted-foreground">
                      {'Attempt automatic router port forwarding'}
                    </p>
                  </div>
                  <Switch
                    checked={useUpnp}
                    onCheckedChange={setUseUpnp}
                    aria-label={'Enable UPnP'}
                  />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{'No Steam'}</p>
                    <p className="text-xs text-muted-foreground">
                      {'Use non-Steam mode (for GOG and LAN setups)'}
                    </p>
                  </div>
                  <Switch
                    checked={useNoSteam}
                    onCheckedChange={setUseNoSteam}
                    aria-label={'Enable no-Steam mode'}
                  />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{'Debug'}</p>
                    <p className="text-xs text-muted-foreground">
                      {'Enable verbose startup and runtime logs'}
                    </p>
                  </div>
                  <Switch
                    checked={useDebug}
                    onCheckedChange={setUseDebug}
                    aria-label={'Enable debug mode'}
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  )

  const renderQuickStep3 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{'Review and Create'}</h2>
        <p className="text-muted-foreground">
          {'Confirm these settings, then create your server entry.'}
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between gap-3 py-2 border-b">
              <span className="text-muted-foreground shrink-0">
                {'Server Files'}
              </span>
              <span
                className="font-mono text-end min-w-0 flex-1 truncate"
                title={installPath}
              >
                {installPath}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{'Server Name'}</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{'Memory'}</span>
              <span className="font-mono">
                {formatMemory(minMemory)}GB - {formatMemory(maxMemory)}GB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{'Game Port'}</span>
              <span className="font-mono">{formatPort(serverPort)}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">{'RCON Port'}</span>
              <span className="font-mono">{formatPort(rconPort)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Button
        onClick={handleQuickSetup}
        disabled={installing || missingAdminPassword}
        className="w-full"
        size="lg"
      >
        {installing ? (
          <>
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
            {'Creating server...'}
          </>
        ) : (
          <>
            <Plus className="w-4 h-4 me-2" />
            {'Create Server'}
          </>
        )}
      </Button>

      {missingAdminPassword && (
        <p className="text-sm text-warning">
          {
            'Add an Admin Password in Advanced Options before creating the server.'
          }
        </p>
      )}

      {logs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">{'Setup Log'}</span>
          </div>
          <ScrollArea className="h-[150px] bg-background rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    log.type === 'error'
                      ? 'text-destructive'
                      : log.type === 'warning'
                        ? 'text-warning'
                        : log.type === 'success'
                          ? 'text-success'
                          : 'text-foreground/80',
                  )}
                >
                  {log.message}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </ScrollArea>
        </div>
      )}

      {installComplete && (
        <Card className="border-primary/30 bg-card shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">{'Server Created!'}</span>
            </div>

            <div className="flex gap-3">
              <Button
                onClick={handleStartServerNow}
                disabled={startingServer}
                className="flex-1"
              >
                {startingServer ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />{' '}
                    {'Starting...'}
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 me-2" /> {'Start Server'}
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                onClick={() => void navigate({ to: '/' })}
              >
                {'Open Dashboard'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )

  const renderStepContent = () => {
    if (setupMode === 'quick') {
      switch (currentStep) {
        case 1:
          return renderQuickStep1()
        case 2:
          return renderQuickStep2()
        case 3:
          return renderQuickStep3()
      }
    } else {
      switch (currentStep) {
        case 1:
          return renderFullStep1()
        case 2:
          return renderFullStep2()
        case 3:
          return renderFullStep3()
        case 4:
          return renderFullStep4()
      }
    }
  }

  const isLastStep = currentStep === totalSteps

  const getStepRequirementMessage = () => {
    if (setupMode === 'quick') {
      if (currentStep === 1)
        return 'Select the dedicated server folder to continue.'
      if (currentStep === 2) {
        if (!serverName.trim() && rconPassword.length < 6)
          return 'Enter a server name and an RCON password (minimum 6 characters).'
        if (!serverName.trim()) return 'Enter a server name to continue.'
        if (rconPassword.length < 6)
          return 'RCON password must be at least 6 characters.'
        if (!adminPassword.trim()) return 'Set an admin password to continue.'
      }
      return ''
    }

    if (currentStep === 1) {
      if (!steamCmdPath.trim()) return 'Set a SteamCMD folder path to continue.'
      if (!hasSteamCmd) return 'Install or confirm SteamCMD to continue.'
    }
    if (currentStep === 2) {
      if (!installPath.trim() && !serverName.trim())
        return 'Set an install folder and server name to continue.'
      if (!installPath.trim()) return 'Set an install folder to continue.'
      if (!serverName.trim()) return 'Enter a server name to continue.'
    }
    if (currentStep === 3) {
      if (rconPassword.length < 6)
        return 'RCON password must be at least 6 characters.'
      if (!adminPassword.trim()) return 'Set an admin password to continue.'
    }
    return ''
  }

  return (
    <>
      <div className="max-w-3xl mx-auto space-y-6 page-transition">
        <div className="text-center">
          <h1 className="text-3xl font-bold">
            {setupMode === 'quick' ? 'Quick Setup' : 'Fresh Install'}
          </h1>
          <p className="text-muted-foreground">
            {setupMode === 'quick'
              ? 'Create and register a server using existing dedicated server files.'
              : 'Download, configure, and register a new dedicated server.'}
          </p>
        </div>

        {renderStepIndicator()}

        <Card>
          <CardContent className="pt-6">{renderStepContent()}</CardContent>
        </Card>

        {!isLastStep && (
          <div className="space-y-2">
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => {
                  if (currentStep === 1) {
                    setSetupMode('select')
                  } else {
                    setCurrentStep((s) => s - 1)
                  }
                }}
              >
                <ChevronLeft className="w-4 h-4 me-2" />
                {currentStep === 1 ? 'Choose Setup Type' : 'Back'}
              </Button>

              <Button
                onClick={() => setCurrentStep((s) => s + 1)}
                disabled={!canProceed}
              >
                {'Next Step'}
                <ChevronRight className="w-4 h-4 ms-2" />
              </Button>
            </div>

            {!canProceed && (
              <p className="text-sm text-warning">
                {getStepRequirementMessage()}
              </p>
            )}
          </div>
        )}

        {isLastStep && !installing && !installComplete && (
          <div className="flex justify-start">
            <Button
              variant="outline"
              onClick={() => setCurrentStep((s) => s - 1)}
            >
              <ChevronLeft className="w-4 h-4 me-2" />
              {'Back'}
            </Button>
          </div>
        )}
      </div>

      <FolderBrowser
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        onSelect={(path) => browseSetter?.fn(path)}
        initialPath={browseSetter?.initial}
        title={browseSetter?.title}
      />
    </>
  )
}
