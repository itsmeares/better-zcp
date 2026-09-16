import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  Link as RouterLink,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { usePageShortcut } from '../hooks/useKeyboardShortcuts'
import {
  Save,
  Server,
  Link,
  Clock,
  Shield,
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  Key,
  Cloud,
  Library,
  Zap,
  CheckCircle2,
  XCircle,
  Download,
  RefreshCw,
  Archive,
  Info,
  Trash2,
  HardDrive,
  RotateCcw,
  Settings2,
  Globe,
  RotateCw,
  Lock,
  User,
  KeyRound,
  ExternalLink,
  FolderOpen,
  Palette,
  Check,
  MessageCircle,
  Plus,
  Minus,
  Search,
  Bookmark,
  BookmarkPlus,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { reportClientError } from '@/lib/client-errors'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { PageSkeleton } from '@/components/PageSkeleton'
import { PasswordInput } from '@/components/PasswordInput'
import { NumberInput } from '@/components/NumberInput'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import { AutoUpdateResultBanner } from '@/components/AutoUpdateResultBanner'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { EmptyState } from '@/components/EmptyState'
import { DisabledReason } from '@/components/DisabledReason'
import {
  configApi,
  panelBridgeApi,
  backupApi,
  authApi,
  serversApi,
  serverApi,
  panelUpdateApi,
  modsApi,
  ApiError,
  BackupStatus,
  ServerBackupArchive,
  PanelUpdateStatus,
  PanelUpdatePreflight,
  PanelUpdateMessage,
  ServerInstance,
} from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useSocket } from '@/contexts/SocketContext'
import { useAuth } from '@/contexts/AuthContext'
import { useTheme, type ThemeName } from '@/contexts/ThemeContext'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { BridgeStatusBadge } from '@/components/BridgeStatusBadge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog'
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
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface AppSettings {
  panelBridgeAutoUpdate: boolean
  panelBridgeSftpEnabled: boolean
  panelBridgeSftpHost: string
  panelBridgeSftpPort: string
  panelBridgeSftpUsername: string
  panelBridgeSftpPassword: string
  panelBridgeSftpBridgePath: string
  panelBridgeSftpPollIntervalSeconds: string
  panelBridgeSftpLogPath: string
  panelBridgeSftpConfigPath: string

  autoStartServer: boolean
  autoExportOnLogin: boolean
  autoExportMaxPerPlayer: string

  modCheckInterval: string
  modAutoRestart: boolean
  modRestartDelay: string
  serverAutoUpdate: boolean
  serverAutoUpdateWarningMinutes: string
  steamUpdateAccount: string

  steamApiKey: string

  workshopCollectionId: string
  workshopCollectionAutoSync: boolean
  steamSessionId: string
  steamLoginSecure: string

  darkMode: boolean
  autoReconnect: boolean
  reconnectInterval: string

  panelPort: string

  httpsEnabled: boolean
  httpsPort: string
  httpsKeyPath: string
  httpsCertPath: string

  corsAllowedOrigins: string
  corsAllowAll: boolean
  corsAllowPrivateNetworks: boolean
  corsDebug: boolean

  enablePublicIpLookup: boolean

  lanIpAddress: string
}

interface CorsDiagnostics {
  allowAll: boolean
  allowPrivateNetworks: boolean
  debug: boolean
  customOrigins: string[]
  effectiveAllowedOrigins: string[]
  blocked: Array<{
    id: number
    origin: string
    source: string
    blockedAt: string
  }>
  blockedCount: number
  lastLoadedAt: string | null
}

const MAX_CORS_ALLOWED_ORIGINS = 100
const MAX_CORS_ORIGIN_LENGTH = 256

function toSettingBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function formatBridgeAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.round(h / 24)
  return `${d}d`
}

function getSftpStatusMessage(transport: {
  lastError?: string | null
  lastErrorGuidance?: string | null
  lastErrorCode?: string | null
}): string {
  const detail = transport.lastError || ''
  return `${detail} Fix: ${transport.lastErrorGuidance || ''}`.trim()
}

function ThemeSelect() {
  const { theme, setTheme } = useTheme()
  return (
    <Select value={theme} onValueChange={(v) => setTheme(v as ThemeName)}>
      <SelectTrigger className="w-[160px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="survival">{'Survival (Dark)'}</SelectItem>
        <SelectItem value="light">{'Light'}</SelectItem>
      </SelectContent>
    </Select>
  )
}

export default function Settings() {
  const runtimeInfo = useRuntimeInfo()
  const socket = useSocket()
  const [settings, setSettings] = useState<AppSettings>({
    panelBridgeAutoUpdate: true,
    panelBridgeSftpEnabled: false,
    panelBridgeSftpHost: '',
    panelBridgeSftpPort: '22',
    panelBridgeSftpUsername: '',
    panelBridgeSftpPassword: '',
    panelBridgeSftpBridgePath: '',
    panelBridgeSftpPollIntervalSeconds: '3',
    panelBridgeSftpLogPath: '',
    panelBridgeSftpConfigPath: '',
    autoStartServer: false,
    autoExportOnLogin: false,
    autoExportMaxPerPlayer: '3',
    modCheckInterval: '5',
    modAutoRestart: true,
    modRestartDelay: '5',
    serverAutoUpdate: false,
    serverAutoUpdateWarningMinutes: '15',
    steamUpdateAccount: '',
    steamApiKey: '',
    workshopCollectionId: '',
    workshopCollectionAutoSync: false,
    steamSessionId: '',
    steamLoginSecure: '',
    darkMode: true,
    autoReconnect: true,
    reconnectInterval: '5',
    panelPort: '3001',
    httpsEnabled: false,
    httpsPort: '3443',
    httpsKeyPath: '',
    httpsCertPath: '',
    corsAllowedOrigins: '',
    corsAllowAll: false,
    corsAllowPrivateNetworks: true,
    corsDebug: false,
    enablePublicIpLookup: false,
    lanIpAddress: '',
  })
  const [originalSettings, setOriginalSettings] = useState<AppSettings | null>(
    null,
  )
  const [loading, setLoading] = useState(false)
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(
    null,
  )
  const [showSteamApiKey, setShowSteamApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [corsOriginValidationError, setCorsOriginValidationError] = useState<
    string | null
  >(null)
  const [corsDiagnostics, setCorsDiagnostics] =
    useState<CorsDiagnostics | null>(null)
  const [corsLoading, setCorsLoading] = useState(false)
  const [corsUpdating, setCorsUpdating] = useState(false)
  const [testingRcon, setTestingRcon] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [panelUpdateStatus, setPanelUpdateStatus] =
    useState<PanelUpdateStatus | null>(null)
  const [panelUpdateStatusError, setPanelUpdateStatusError] = useState<
    string | null
  >(null)
  const [checkingPanelUpdate, setCheckingPanelUpdate] = useState(false)
  const [downloadingPanelUpdate, setDownloadingPanelUpdate] = useState(false)
  const [dockerUpdateConfirmOpen, setDockerUpdateConfirmOpen] = useState(false)
  const [panelUpdateReady, setPanelUpdateReady] = useState(false)
  const [panelUpdatePreflight, setPanelUpdatePreflight] =
    useState<PanelUpdatePreflight | null>(null)
  const [panelApplyLog, setPanelApplyLog] = useState<string | null>(null)
  const [panelApplyResultDismissed, setPanelApplyResultDismissed] =
    useState(false)
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false)
  const [restartRiskConfirmed, setRestartRiskConfirmed] = useState(false)
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false)
  const [applyRiskConfirmed, setApplyRiskConfirmed] = useState(false)
  const { toast } = useToast()
  const { user, authEnabled, logout } = useAuth()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [regenerateJwtDialogOpen, setRegenerateJwtDialogOpen] = useState(false)
  const [regeneratingJwtSecret, setRegeneratingJwtSecret] = useState(false)
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [localPasswordResetSupported, setLocalPasswordResetSupported] =
    useState(false)
  const [showLocalPasswordReset, setShowLocalPasswordReset] = useState(false)
  const [localPasswordResetToken, setLocalPasswordResetToken] = useState('')
  const [localPasswordResetPassword, setLocalPasswordResetPassword] =
    useState('')
  const [localPasswordResetConfirm, setLocalPasswordResetConfirm] = useState('')
  const [preparingLocalPasswordReset, setPreparingLocalPasswordReset] =
    useState(false)
  const [resettingLocalPassword, setResettingLocalPassword] = useState(false)
  const [showLocalResetPassword, setShowLocalResetPassword] = useState(false)

  const [bridgeStatus, setBridgeStatus] = useState<{
    configured: boolean
    bridgePath: string | null
    isRunning: boolean
    pendingCommands: number
    modConnected: boolean
    consecutiveFailures?: number
    hasFileWatcher?: boolean
    transport?: {
      type: 'local' | 'sftp'
      running: boolean
      lastLatencyMs?: number | null
      lastError?: string | null
      lastErrorGuidance?: string | null
      lastErrorCode?: string | null
    }
    config?: {
      statusStaleMs: number
      pollIntervalMs: number
      statusCheckMs: number
    }
    connection?: {
      healthy: boolean
      canSendCommands: boolean
      summary: string
      issues: string[]
      checks: Record<string, boolean | number | null>
    }
    statusFile?: {
      exists: boolean
      path?: string
      size?: number
      modified?: string
      age?: number
      ageSeconds?: number
      error?: string
    }
    modStatus: {
      alive: boolean
      version: string
      serverName: string
      playerCount?: number
      players: string[]
      path: string
      timestamp: number
      age?: number
      error?: string
    } | null
    detectedPaths?: {
      serverName: string
      installPath: string
      zomboidDataPath: string
    } | null
  } | null>(null)
  const [bridgeLoading, setBridgeLoading] = useState(false)
  const [bridgeError, setBridgeError] = useState<string | null>(null)
  const [pinging, setPinging] = useState(false)
  const [manualBridgePath, setManualBridgePath] = useState('')
  const [testingSftp, setTestingSftp] = useState(false)
  const [remoteLogs, setRemoteLogs] = useState<
    Array<{ name: string; size: number; modifiedAt: string | null }>
  >([])
  const [remoteLogContent, setRemoteLogContent] = useState<{
    name: string
    content: string
    truncated: boolean
    bytesReturned: number
  } | null>(null)
  const [loadingRemoteLogs, setLoadingRemoteLogs] = useState(false)
  const [remoteLogError, setRemoteLogError] = useState<string | null>(null)
  const [remoteConfigFiles, setRemoteConfigFiles] = useState<
    Array<{ name: string; size: number; modifiedAt: string | null }>
  >([])
  const [loadingRemoteConfig, setLoadingRemoteConfig] = useState(false)
  const [remoteConfigError, setRemoteConfigError] = useState<string | null>(
    null,
  )

  const [servers, setServers] = useState<ServerInstance[]>([])
  const [serversLoadError, setServersLoadError] = useState(false)
  const [selectedInstallServerId, setSelectedInstallServerId] =
    useState<string>('')
  const [installingMod, setInstallingMod] = useState(false)

  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backups, setBackups] = useState<ServerBackupArchive[]>([])
  const [backupsLoadError, setBackupsLoadError] = useState(false)
  const [backupStatusLoadError, setBackupStatusLoadError] = useState(false)
  const [backupLoading, setBackupLoading] = useState(false)
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
  const [restoreConfirmBackup, setRestoreConfirmBackup] = useState<
    string | null
  >(null)
  const [backupSchedule, setBackupSchedule] = useState('0 */6 * * *')
  const [backupMaxCount, setBackupMaxCount] = useState(10)

  const isDirty =
    originalSettings !== null &&
    JSON.stringify(settings) !== JSON.stringify(originalSettings)

  const settingsSections = [
    {
      id: 'general',
      label: 'General',
      icon: Settings2,
      group: 'Panel',
      tip: 'Panel port, restart, and appearance',
      description: 'Port this admin interface listens on, plus theme.',
    },
    {
      id: 'updates',
      label: 'Updates',
      icon: Download,
      group: 'Panel',
      tip: 'Check for and apply new panel releases',
      description: 'Panel release checks, downloads, and how updates apply.',
    },
    {
      id: 'https',
      label: 'HTTPS',
      icon: Lock,
      group: 'Panel',
      tip: 'TLS certificates for encrypted connections',
      description:
        'TLS termination. Enable this when exposing the panel beyond your LAN.',
    },
    {
      id: 'access',
      label: 'Remote access',
      icon: Globe,
      group: 'Panel',
      tip: 'Which browsers and devices may connect (CORS)',
      description:
        'Which origins may reach this panel from another machine, and why requests get blocked.',
    },
    {
      id: 'security',
      label: 'Security',
      icon: Shield,
      group: 'Panel',
      tip: 'Account password and sign-in',
      description: 'Panel account password and sign-in controls.',
    },
    {
      id: 'connection',
      label: 'RCON',
      icon: Link,
      group: 'Game server',
      tip: 'Remote console connection and startup behaviour',
      description:
        'RCON connection used for commands, plus whether the game server starts with the panel.',
    },
    {
      id: 'bridge',
      label: 'PanelBridge',
      icon: Zap,
      group: 'Game server',
      tip: 'Lua mod link, including remote servers over SFTP',
      description:
        'PanelBridge Lua mod link for weather, teleport, and item control. Supports remote servers over SFTP.',
    },
    {
      id: 'mods',
      label: 'Mods & Workshop',
      icon: Clock,
      group: 'Automation',
      tip: 'Update checks, collection sync, and Steam key',
      description:
        'Workshop update detection, collection sync, and the Steam Web API key they rely on.',
    },
    {
      id: 'backups',
      label: 'Backups',
      icon: Archive,
      group: 'Automation',
      tip: 'World backup schedule and character exports',
      description: 'Automatic world backups and per-character export copies.',
    },
    {
      id: 'about',
      label: 'About',
      icon: Info,
      group: 'System',
      tip: 'Version, runtime info, and settings kept on other pages',
      description:
        'Panel version and runtime details, plus where the remaining settings live.',
    },
  ]
  const settingsGroups = settingsSections.reduce<
    { name: string; sections: typeof settingsSections }[]
  >((groups, section) => {
    const existing = groups.find((group) => group.name === section.group)
    if (existing) existing.sections.push(section)
    else groups.push({ name: section.group, sections: [section] })
    return groups
  }, [])
  const legacyTabAliases: Record<string, string> = {
    panel: 'general',
    rcon: 'connection',
    'api-keys': 'mods',
  }
  const validTabs = settingsSections.map((s) => s.id)
  const resolveTabId = (tab: string | null) => {
    if (!tab) return null
    const resolved = legacyTabAliases[tab] ?? tab
    return validTabs.includes(resolved) ? resolved : null
  }
  const { searchStr } = useLocation()
  const navigate = useNavigate()
  const searchParams = new URLSearchParams(searchStr)
  const [activeSection, setActiveSection] = useState(
    () => resolveTabId(searchParams.get('tab')) ?? 'general',
  )

  const handleTabChange = useCallback(
    (value: string) => {
      setActiveSection(value)
      void navigate({ to: '/settings', search: { tab: value }, replace: true })
    },
    [navigate],
  )

  useEffect(() => {
    const resolved = resolveTabId(searchParams.get('tab'))
    if (resolved && resolved !== activeSection) {
      setActiveSection(resolved)
    }
  }, [searchStr]) // eslint-disable-line react-hooks/exhaustive-deps -- resolveTabId/activeSection intentionally excluded: recomputed fresh each render off settingsSections (stable per render), including them would re-run this on every activeSection change instead of only on external URL changes

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty])

  useEffect(
    () => () => {
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current)
    },
    [],
  )

  const fetchSettings = useCallback(async () => {
    setLoading(true)
    try {
      const data = await configApi.getAppSettings()
      setSettingsLoadError(null)
      if (data.settings) {
        setSettings((prevSettings) => {
          const incoming = data.settings as Partial<AppSettings>
          const loadedSettings: AppSettings = {
            ...prevSettings,
            ...incoming,
            autoStartServer: toSettingBoolean(incoming.autoStartServer, false),
            autoExportOnLogin: toSettingBoolean(
              incoming.autoExportOnLogin,
              false,
            ),
            autoExportMaxPerPlayer: String(
              incoming.autoExportMaxPerPlayer ??
                prevSettings.autoExportMaxPerPlayer,
            ),
          }
          setOriginalSettings(loadedSettings)
          return loadedSettings
        })
      }
    } catch (error) {
      reportClientError('Failed to fetch settings.', error)
      const message = getUserErrorMessage(error, 'The settings request failed.')
      setSettingsLoadError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const fetchCorsDiagnostics = useCallback(async () => {
    setCorsLoading(true)
    try {
      const data = await configApi.getCorsDiagnostics()
      setCorsDiagnostics(data.diagnostics)
    } catch (error) {
      reportClientError('Failed to fetch CORS diagnostics.', error)
      toast({
        title: "Couldn't refresh CORS diagnostics",
        description: 'The numbers below are stale, not current.',
        variant: 'destructive',
      })
    } finally {
      setCorsLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchCorsDiagnostics()
  }, [fetchCorsDiagnostics])

  const [networkInterfaces, setNetworkInterfaces] = useState<
    { name: string; address: string }[]
  >([])
  useEffect(() => {
    serverApi
      .getNetworkInterfaces()
      .then((data) => setNetworkInterfaces(data.interfaces || []))
      .catch(() => setNetworkInterfaces([]))
  }, [])

  const fetchPanelUpdateStatus = useCallback(async () => {
    try {
      const status = await panelUpdateApi.getStatus()
      setPanelUpdateStatus(status)
      setPanelUpdateStatusError(null)
      if (
        status.lastApplyResult?.status === 'failed' &&
        status.lastApplyResult.canRetryApply === false
      ) {
        setPanelUpdateReady(false)
      } else if (status.stagedUpdate) {
        setPanelUpdateReady(true)
      } else if (!status.updateAvailable) {
        setPanelUpdateReady(false)
      }
      if (status.lastApplyResult?.status === 'failed') {
        if (status.lastApplyResult.helperLog) {
          setPanelApplyLog(status.lastApplyResult.helperLog)
        } else {
          try {
            const { log: helperLog } = await panelUpdateApi.getApplyLog()
            setPanelApplyLog(helperLog)
          } catch {
            setPanelApplyLog(null)
          }
        }
      }
    } catch (error) {
      const message = getUserErrorMessage(
        error,
        'Could not load updater status',
      )
      setPanelUpdateStatusError(message)
      reportClientError('Failed to fetch panel update status.', error)
    }
  }, [])

  const fetchPanelUpdatePreflight = useCallback(async () => {
    try {
      const pre = await panelUpdateApi.preflight()
      setPanelUpdatePreflight(pre)
      return pre
    } catch (error) {
      reportClientError('Failed to fetch panel update preflight.', error)
      return null
    }
  }, [])

  useEffect(() => {
    fetchPanelUpdateStatus()
  }, [fetchPanelUpdateStatus])

  const hasActionablePanelUpdate = Boolean(
    panelUpdateStatus?.updateAvailable || panelUpdateStatus?.stagedUpdate,
  )
  const isDockerPanelUpdate = panelUpdateStatus?.updateMode === 'docker'
  const stagedPanelUpdatePath = panelUpdateStatus?.stagedUpdate?.path
  const panelRestartAssessment = runtimeInfo?.restartAssessment
  const updateRestartAssessment =
    panelUpdatePreflight?.info.restartAssessment ?? panelRestartAssessment
  const panelRestartIsRisky =
    panelRestartAssessment?.gameServers !== 'preserved' ||
    Boolean(panelRestartAssessment?.requiresConfirmation)
  const updateRestartIsRisky =
    updateRestartAssessment?.gameServers !== 'preserved' ||
    Boolean(updateRestartAssessment?.requiresConfirmation)
  const restartAssessmentMessage = (
    assessment: typeof panelRestartAssessment,
    scope: 'general' | 'updates',
  ) => {
    if (assessment?.gameServers === 'preserved') {
      return scope === 'general'
        ? 'Running game servers will remain online.'
        : 'Running game servers will remain online during this update.'
    }
    if (assessment?.gameServers === 'at-risk') {
      return scope === 'general'
        ? 'Restarting the panel may stop running game servers.'
        : 'This update may stop running game servers.'
    }
    return scope === 'general'
      ? 'The effect on running game servers could not be determined.'
      : 'The update effect on running game servers could not be determined.'
  }

  const translatePanelUpdateMessages = (
    messages: string[],
    _details?: PanelUpdateMessage[],
  ) => messages.map((message) => message)

  useEffect(() => {
    if (!hasActionablePanelUpdate) return
    fetchPanelUpdatePreflight()
  }, [
    hasActionablePanelUpdate,
    stagedPanelUpdatePath,
    fetchPanelUpdatePreflight,
  ])

  const normalizePort = (value: string): string => {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) {
      return String(parsed)
    }
    return '3001'
  }

  const validateCorsOriginsInput = useCallback(
    (rawInput: string): string | null => {
      const origins = rawInput
        .split(/[\n,;]+/)
        .map((origin) => origin.trim())
        .filter(Boolean)

      if (origins.length > MAX_CORS_ALLOWED_ORIGINS) {
        return (
          'Too many origins. Maximum is ' +
          String(MAX_CORS_ALLOWED_ORIGINS) +
          '.'
        )
      }

      for (const origin of origins) {
        if (origin.length > MAX_CORS_ORIGIN_LENGTH) {
          return (
            'Origin too long (' +
            String(origin.length) +
            ' chars). Maximum is ' +
            String(MAX_CORS_ORIGIN_LENGTH) +
            '.'
          )
        }

        try {
          const parsed = new URL(origin)
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return 'Only http/https origins are allowed: ' + String(origin)
          }
        } catch {
          return 'Invalid origin format: ' + String(origin)
        }
      }

      return null
    },
    [],
  )

  useEffect(() => {
    setCorsOriginValidationError(
      validateCorsOriginsInput(settings.corsAllowedOrigins),
    )
  }, [settings.corsAllowedOrigins, validateCorsOriginsInput])

  const handleSave = async () => {
    if (!isValidPort(Number(settings.panelPort))) {
      toast({
        title: 'Invalid Panel Port',
        description: 'Panel port must be a whole number between 1 and 65535.',
        variant: 'destructive',
      })
      return
    }
    if (settings.httpsEnabled && !isValidPort(Number(settings.httpsPort))) {
      toast({
        title: 'Invalid HTTPS Port',
        description: 'HTTPS port must be a whole number between 1 and 65535.',
        variant: 'destructive',
      })
      return
    }

    const validationError = validateCorsOriginsInput(
      settings.corsAllowedOrigins,
    )
    if (validationError) {
      setCorsOriginValidationError(validationError)
      toast({
        title: 'Invalid CORS Origins',
        description: validationError,
        variant: 'destructive',
      })
      return
    }

    setSaving(true)
    try {
      await configApi.updateAppSettings(
        settings as unknown as Record<string, unknown>,
      )
      setOriginalSettings(settings)
      try {
        await fetchCorsDiagnostics()
      } catch {
        // Settings are already saved; diagnostics refresh is best-effort.
      }
      toast({
        title: 'Settings Saved',
        description: 'Your panel settings were saved.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Could Not Save Settings',
        description: getUserErrorMessage(
          error,
          'The panel could not save your settings. Try again.',
        ),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  usePageShortcut(
    's',
    () => {
      if (isDirty && !saving) handleSave()
    },
    { ctrl: true },
  )

  const handleReloadCorsRules = async () => {
    setCorsUpdating(true)
    try {
      const data = await configApi.reloadCorsDiagnostics()
      setCorsDiagnostics(data.diagnostics)
      toast({
        title: 'CORS Rules Reloaded',
        description: 'The backend reloaded CORS settings from the database.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Could Not Reload CORS Rules',
        description: getUserErrorMessage(error, 'Failed to reload CORS rules.'),
        variant: 'destructive',
      })
    } finally {
      setCorsUpdating(false)
    }
  }

  const handleClearCorsBlocked = async () => {
    setCorsUpdating(true)
    try {
      const data = await configApi.clearCorsBlockedOrigins()
      setCorsDiagnostics(data.diagnostics)
      toast({
        title: 'Blocked Origin Log Cleared',
        description:
          'Recent blocked CORS origins were removed from diagnostics.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Could Not Clear Log',
        description: getUserErrorMessage(
          error,
          'Failed to clear blocked CORS origins.',
        ),
        variant: 'destructive',
      })
    } finally {
      setCorsUpdating(false)
    }
  }

  const restartPanelWithReconnect = useCallback(
    async (description: string) => {
      setRestarting(true)
      try {
        await serverApi.restartPanel()
        toast({
          title: 'Restarting Panel',
          description,
        })

        if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current)
        restartTimeoutRef.current = setTimeout(() => {
          const newPort = normalizePort(settings.panelPort)
          const newUrl = `${window.location.protocol}//${window.location.hostname}:${newPort}${window.location.pathname}${window.location.search}${window.location.hash}`
          window.location.href = newUrl
        }, 3000)
      } catch (err) {
        setRestarting(false)
        const apiErr = err as { code?: string; message?: string }
        if (apiErr?.code === 'apply_in_progress') {
          toast({
            title: 'Update already in progress',
            description: getUserErrorMessage(
              err,
              'An update apply is already running. Wait for the panel to reconnect.',
            ),
          })
          return
        }
        toast({
          title: 'Restart Failed',
          description:
            'Could not restart the panel. You may need to restart it manually.',
          variant: 'destructive',
        })
      }
    },
    [settings.panelPort, toast],
  )

  const handleCheckPanelUpdate = async () => {
    setCheckingPanelUpdate(true)
    setPanelUpdateStatusError(null)
    try {
      const status = await panelUpdateApi.check()
      setPanelUpdateStatus(status)

      if (status.updateAvailable) {
        toast({
          title: 'Update Available',
          description:
            'A newer panel version is available: v' +
            String(status.latestVersion) +
            ' (installed: v' +
            String(status.currentVersion) +
            ').',
        })
      } else {
        setPanelUpdateReady(false)
        toast({
          title: 'Up to Date',
          description:
            'You are running the latest panel release (v' +
            String(status.currentVersion) +
            ').',
          variant: 'success' as const,
        })
      }
    } catch (error) {
      toast({
        title: 'Update Check Failed',
        description: getUserErrorMessage(
          error,
          'The panel could not reach GitHub. Check your connection and try again.',
        ),
        variant: 'destructive',
      })
    } finally {
      setCheckingPanelUpdate(false)
    }
  }

  const handleDownloadPanelUpdate = async () => {
    if (!panelUpdateStatus?.updateAvailable) {
      toast({
        title: 'No Update Available',
        description:
          'No newer release was found. Run Check for Updates to refresh status.',
      })
      return
    }

    setDownloadingPanelUpdate(true)
    setPanelUpdateStatusError(null)
    try {
      const pre = await fetchPanelUpdatePreflight()
      if (!pre || !pre.ok) {
        throw new Error(
          pre?.blockers[0] || 'Update blocked by preflight check.',
        )
      }

      const result = await panelUpdateApi.download(isDockerPanelUpdate)

      if (!isDockerPanelUpdate) setPanelUpdateReady(true)
      toast({
        title: isDockerPanelUpdate
          ? 'Docker Update Started'
          : 'Update Downloaded',
        description:
          result.message ||
          (isDockerPanelUpdate
            ? 'The panel container is rebuilding and will reconnect when the health check passes.'
            : 'The update files are ready. Restart the panel to apply this version.'),
        variant: 'success' as const,
      })
      await fetchPanelUpdateStatus()
    } catch (error) {
      const data =
        error instanceof ApiError
          ? (error.data as { preflight?: PanelUpdatePreflight } | undefined)
          : undefined
      if (data?.preflight) setPanelUpdatePreflight(data.preflight)
      toast({
        title: 'Download Failed',
        description: getUserErrorMessage(
          error,
          'The panel could not download the update. Check network access, disk space, and permissions.',
        ),
        variant: 'destructive',
      })
    } finally {
      setDownloadingPanelUpdate(false)
    }
  }

  const formatTimestamp = (value: string | null): string => {
    if (!value) return 'Never'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return 'Unknown'
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  }

  useEffect(() => {
    if (!socket) return

    const handlePanelUpdateAvailable = (data: {
      latestVersion?: string
      currentVersion?: string
      releaseUrl?: string
    }) => {
      setPanelUpdateStatus((prev) => {
        const base: PanelUpdateStatus = prev || {
          currentVersion: data.currentVersion || 'Unknown',
          updateAvailable: true,
          latestVersion: data.latestVersion || null,
          releaseUrl: data.releaseUrl || null,
          releaseNotes: null,
          publishedAt: null,
          isChecking: false,
          isDownloading: false,
          downloadProgress: 0,
          lastCheck: new Date().toISOString(),
          lastError: null,
          stagedUpdate: null,
          lastApplyResult: null,
        }
        return {
          ...base,
          updateAvailable: true,
          latestVersion: data.latestVersion || base.latestVersion,
          currentVersion: data.currentVersion || base.currentVersion,
          releaseUrl: data.releaseUrl || base.releaseUrl,
          lastError: null,
        }
      })
    }

    const handlePanelDownloadProgress = (data: {
      progress?: number
      status?: string
    }) => {
      setPanelUpdateStatus((prev) => {
        const base: PanelUpdateStatus = prev || {
          currentVersion: 'Unknown',
          updateAvailable: true,
          latestVersion: null,
          releaseUrl: null,
          releaseNotes: null,
          publishedAt: null,
          isChecking: false,
          isDownloading: false,
          downloadProgress: 0,
          lastCheck: null,
          lastError: null,
          stagedUpdate: null,
          lastApplyResult: null,
        }
        const bounded = Math.max(
          0,
          Math.min(100, data.progress ?? base.downloadProgress),
        )
        return {
          ...base,
          isDownloading:
            data.status === 'downloading' || data.status === 'preparing',
          downloadProgress: bounded,
        }
      })
    }

    const handlePanelUpdateReady = (data: { version?: string }) => {
      setPanelUpdateReady(true)
      toast({
        title: 'Update Ready',
        description: data.version
          ? 'Panel v' +
            String(data.version) +
            ' is downloaded. Restart the panel to switch to the new version.'
          : 'The update is downloaded. Restart the panel to switch to the new version.',
        variant: 'success' as const,
      })
      setPanelUpdateStatusError(null)
      fetchPanelUpdateStatus()
    }

    const handlePanelUpdateApplied = (data: { version?: string }) => {
      setPanelUpdateReady(false)
      setPanelApplyResultDismissed(false)
      setPanelApplyLog(null)
      toast({
        title: 'Update Applied',
        description: data.version
          ? 'Panel successfully updated to v' + String(data.version) + '.'
          : 'Panel update applied successfully.',
        variant: 'success' as const,
      })
      fetchPanelUpdateStatus()
    }

    const handlePanelUpdateApplyFailed = (data: {
      pendingVersion?: string
      helperLog?: string | null
    }) => {
      setPanelApplyResultDismissed(false)
      if (data?.helperLog) setPanelApplyLog(data.helperLog)
      toast({
        title: 'Update Failed to Apply',
        description: data?.pendingVersion
          ? 'Panel is still running the previous version. The v' +
            String(data.pendingVersion) +
            ' update did not install.'
          : 'The downloaded update did not install. Review the helper log for details.',
        variant: 'destructive',
      })
      fetchPanelUpdateStatus()
    }

    socket.on('panel:updateAvailable', handlePanelUpdateAvailable)
    socket.on('panel:downloadProgress', handlePanelDownloadProgress)
    socket.on('panel:updateReady', handlePanelUpdateReady)
    socket.on('panel:updateApplied', handlePanelUpdateApplied)
    socket.on('panel:updateApplyFailed', handlePanelUpdateApplyFailed)

    return () => {
      socket.off('panel:updateAvailable', handlePanelUpdateAvailable)
      socket.off('panel:downloadProgress', handlePanelDownloadProgress)
      socket.off('panel:updateReady', handlePanelUpdateReady)
      socket.off('panel:updateApplied', handlePanelUpdateApplied)
      socket.off('panel:updateApplyFailed', handlePanelUpdateApplyFailed)
    }
  }, [socket, toast, fetchPanelUpdateStatus])

  const handleTestRcon = async () => {
    setTestingRcon(true)
    try {
      await configApi.testRcon()
      toast({
        title: 'RCON Connected',
        description: 'The panel connected to your server over RCON.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'RCON Connection Failed',
        description: getUserErrorMessage(
          error,
          'The panel could not connect to RCON. Verify host, port, password, and firewall rules.',
        ),
        variant: 'destructive',
      })
    } finally {
      setTestingRcon(false)
    }
  }

  const fetchBridgeStatus = useCallback(async () => {
    try {
      const status = await panelBridgeApi.getStatus()
      setBridgeStatus(status)
      setBridgeError(null)
    } catch (error) {
      reportClientError('Failed to fetch bridge status.', error)
      setBridgeError(
        getUserErrorMessage(
          error,
          "Couldn't reach the bridge status endpoint.",
        ),
      )
    }
  }, [])

  const fetchServers = useCallback(async () => {
    try {
      const data = await serversApi.getAll()
      setServers(data.servers || [])
      setServersLoadError(false)
      const activeServer = data.servers?.find((s) => s.isActive)
      if (activeServer && !selectedInstallServerId) {
        setSelectedInstallServerId(String(activeServer.id))
      }
    } catch (error) {
      reportClientError('Failed to fetch servers.', error)
      setServersLoadError(true)
    }
  }, [selectedInstallServerId])

  useEffect(() => {
    if (!socket) return

    const handleActiveServerChanged = () => {
      fetchServers()
      if (!isDirty) fetchSettings()
    }

    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, fetchSettings, fetchServers, isDirty])

  const handleInstallMod = async () => {
    if (!selectedInstallServerId) {
      toast({
        title: 'Select a Server',
        description:
          'Choose the server where you want to install PanelBridge.lua.',
        variant: 'destructive',
      })
      return
    }

    if (selectedInstallServer?.isRemote) {
      toast({
        title: 'Manual install required',
        description:
          "Remote servers cannot be written from this computer. Copy PanelBridge.lua to the server's Lua folder using SFTP or the hosting provider's file manager.",
        variant: 'destructive',
      })
      return
    }

    setInstallingMod(true)
    try {
      const result = await panelBridgeApi.installModAuto(
        selectedInstallServerId,
      )
      toast({
        title: 'PanelBridge Installed',
        description:
          'PanelBridge.lua was copied to ' +
          String(result.serverName || 'the selected server') +
          '.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Installation Failed',
        description: getUserErrorMessage(
          error,
          'The panel could not copy PanelBridge.lua. Verify the server path and permissions, then try again.',
        ),
        variant: 'destructive',
      })
    } finally {
      setInstallingMod(false)
    }
  }

  const bridgeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bridgeStatusRef = useRef(bridgeStatus)

  useEffect(() => {
    bridgeStatusRef.current = bridgeStatus
  }, [bridgeStatus])

  useEffect(() => {
    fetchBridgeStatus()
    fetchServers()

    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const scheduleNextFetch = () => {
      const status = bridgeStatusRef.current
      const interval = status?.isRunning && !status?.modConnected ? 3000 : 10000

      timeoutId = setTimeout(async () => {
        if (document.visibilityState !== 'hidden') {
          await fetchBridgeStatus()
        }
        scheduleNextFetch()
      }, interval)
    }

    scheduleNextFetch()

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      if (bridgeIntervalRef.current) {
        clearInterval(bridgeIntervalRef.current)
        bridgeIntervalRef.current = null
      }
    }
  }, [fetchBridgeStatus, fetchServers])

  const fetchBackupStatus = useCallback(async () => {
    try {
      const status = await backupApi.getStatus()
      setBackupStatus(status)
      setBackupSchedule(status.schedule)
      setBackupMaxCount(status.maxBackups)
      setBackupStatusLoadError(false)
    } catch (error) {
      reportClientError('Failed to fetch backup status.', error)
      setBackupStatusLoadError(true)
    }
  }, [])

  const fetchBackups = useCallback(async () => {
    try {
      const data = await backupApi.listBackups()
      setBackups(data.backups || [])
      setBackupsLoadError(false)
    } catch (error) {
      reportClientError('Failed to fetch backups.', error)
      setBackupsLoadError(true)
    }
  }, [])

  useEffect(() => {
    fetchBackupStatus()
    fetchBackups()
  }, [fetchBackupStatus, fetchBackups])

  const handleCreateBackup = async () => {
    setCreatingBackup(true)
    try {
      const result = await backupApi.createBackup()
      if (result.success && result.backup) {
        toast({
          title: 'Backup Created',
          description:
            'Created ' +
            String(result.backup.name) +
            ' in ' +
            String(result.duration?.toFixed(1)) +
            's',
          variant: 'success' as const,
        })
        await fetchBackups()
        await fetchBackupStatus()
      } else {
        throw new Error(result.message || 'Failed to create backup')
      }
    } catch (error) {
      toast({
        title: 'Backup Failed',
        description: getUserErrorMessage(error, 'Failed to create backup'),
        variant: 'destructive',
      })
    } finally {
      setCreatingBackup(false)
    }
  }

  const handleDeleteBackup = async (name: string) => {
    try {
      await backupApi.deleteBackup(name)
      toast({
        title: 'Backup Deleted',
        description: 'Deleted ' + String(name),
        variant: 'success' as const,
      })
      await fetchBackups()
    } catch (error) {
      toast({
        title: 'Delete Failed',
        description: getUserErrorMessage(error, 'Failed to delete backup'),
        variant: 'destructive',
      })
    }
  }

  const handleRestoreBackup = async (name: string) => {
    setRestoringBackup(name)
    try {
      const result = await backupApi.restoreBackup(name, {
        createPreRestoreBackup: true,
      })
      toast({
        title: 'Backup Restored',
        description:
          'Restored ' +
          String(name) +
          ' in ' +
          String((result.duration || 0).toFixed(1)) +
          's',
        variant: 'success' as const,
      })
      await fetchBackups()
    } catch (error) {
      toast({
        title: 'Restore Failed',
        description: getUserErrorMessage(error, 'Failed to restore backup'),
        variant: 'destructive',
      })
    } finally {
      setRestoringBackup(null)
      setRestoreConfirmBackup(null)
    }
  }

  const isValidCron = (cron: string): boolean => {
    const parts = cron.trim().split(/\s+/)
    if (parts.length !== 5) return false

    const patterns = [
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // minute
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // hour
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // day of month
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // month
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // day of week
    ]

    return parts.every((part, i) => patterns[i].test(part))
  }

  const handleSaveBackupSettings = async () => {
    if (!isValidCron(backupSchedule)) {
      toast({
        title: 'Invalid Schedule',
        description: 'Please enter a valid cron expression (e.g., 0 */6 * * *)',
        variant: 'destructive',
      })
      return
    }

    setBackupLoading(true)
    try {
      await backupApi.updateSettings({
        enabled: backupStatus?.enabled || false,
        schedule: backupSchedule,
        maxBackups: backupMaxCount,
      })
      await fetchBackupStatus()
      toast({
        title: 'Backup Settings Saved',
        description: 'Backup schedule and retention settings were updated.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Could Not Save Backup Settings',
        description: getUserErrorMessage(
          error,
          'The panel could not save backup schedule settings. Try again.',
        ),
        variant: 'destructive',
      })
    } finally {
      setBackupLoading(false)
    }
  }

  const toggleBackupEnabled = async (enabled: boolean) => {
    setBackupLoading(true)
    try {
      await backupApi.updateSettings({ enabled })
      await fetchBackupStatus()
      toast({
        title: enabled
          ? 'Scheduled Backups Enabled'
          : 'Scheduled Backups Disabled',
        description: enabled
          ? 'The panel will create backups on the configured schedule.'
          : 'Automatic backups are off. Manual backups are still available.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Could Not Update Backups',
        description: getUserErrorMessage(
          error,
          'The panel could not update scheduled backup status. Try again.',
        ),
        variant: 'destructive',
      })
    } finally {
      setBackupLoading(false)
    }
  }

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  const fetchBridgeStatusRef = useRef(fetchBridgeStatus)
  useEffect(() => {
    fetchBridgeStatusRef.current = fetchBridgeStatus
  }, [fetchBridgeStatus])

  useEffect(() => {
    if (!socket) return

    const handleBridgeStatus = (data: {
      isRunning: boolean
      bridgePath: string
    }) => {
      setBridgeStatus((prev) =>
        prev
          ? { ...prev, isRunning: data.isRunning, bridgePath: data.bridgePath }
          : null,
      )
      fetchBridgeStatusRef.current()
    }

    const handleModStatus = (data: {
      alive: boolean
      version?: string
      serverName?: string
      playerCount?: number
      players?: string[] | Record<string, unknown>
      path?: string
      timestamp?: number
    }) => {
      setBridgeStatus((prev) => {
        if (!prev) return null
        const prevModStatus = prev.modStatus
        const newModStatus = {
          alive: data.alive,
          version: data.version || prevModStatus?.version || '',
          serverName: data.serverName || prevModStatus?.serverName || '',
          playerCount: data.alive ? (data.playerCount ?? 0) : undefined,
          players: Array.isArray(data.players)
            ? data.players
            : Object.keys(data.players || {}),
          path: data.path || prevModStatus?.path || '',
          timestamp: data.timestamp || Date.now(),
        }
        return {
          ...prev,
          modConnected: data.alive,
          modStatus: newModStatus,
        }
      })
    }

    const handleBridgeConfigured = (data: { bridgePath: string }) => {
      setBridgeStatus((prev) =>
        prev
          ? { ...prev, bridgePath: data.bridgePath, configured: true }
          : null,
      )
      fetchBridgeStatusRef.current()
    }

    socket.on('panelBridge:status', handleBridgeStatus)
    socket.on('panelBridge:modStatus', handleModStatus)
    socket.on('panelBridge:configured', handleBridgeConfigured)

    return () => {
      socket.off('panelBridge:status', handleBridgeStatus)
      socket.off('panelBridge:modStatus', handleModStatus)
      socket.off('panelBridge:configured', handleBridgeConfigured)
    }
  }, [socket])

  const handleAutoConfigure = async () => {
    setBridgeLoading(true)
    setBridgeError(null)
    try {
      const result = await panelBridgeApi.autoConfigure()
      toast({
        title: 'Bridge Auto-Configured',
        description: 'Connected to server: ' + String(result.serverName),
        variant: 'success' as const,
      })
      await fetchBridgeStatus()
    } catch (error) {
      setBridgeError(getUserErrorMessage(error, 'Failed to auto-configure'))
    } finally {
      setBridgeLoading(false)
    }
  }

  const handleStopBridge = async () => {
    setBridgeLoading(true)
    try {
      await panelBridgeApi.stop()
      toast({
        title: 'Bridge Stopped',
        description: 'Panel Bridge has been stopped',
        variant: 'success' as const,
      })
      await fetchBridgeStatus()
    } catch (error) {
      toast({
        title: 'Failed to Stop',
        description: getUserErrorMessage(
          error,
          'The panel could not stop Panel Bridge. Try again.',
        ),
        variant: 'destructive',
      })
    } finally {
      setBridgeLoading(false)
    }
  }

  const handleManualConfigure = async () => {
    const trimmed = manualBridgePath.trim()
    if (!trimmed) return
    setBridgeLoading(true)
    setBridgeError(null)
    try {
      const result = await panelBridgeApi.configureDirect(trimmed)
      toast({
        title: 'Bridge Configured',
        description: 'Watching: ' + String(result.bridgePath),
        variant: 'success' as const,
      })
      setManualBridgePath('')
      await fetchBridgeStatus()
    } catch (error) {
      setBridgeError(
        getUserErrorMessage(
          error,
          'Failed to configure bridge with manual path',
        ),
      )
    } finally {
      setBridgeLoading(false)
    }
  }

  const sftpConfig = () => ({
    host: settings.panelBridgeSftpHost,
    port: settings.panelBridgeSftpPort,
    username: settings.panelBridgeSftpUsername,
    password: settings.panelBridgeSftpPassword,
    bridgePath: settings.panelBridgeSftpBridgePath,
    pollIntervalSeconds: settings.panelBridgeSftpPollIntervalSeconds,
  })

  const handleListRemoteLogs = async () => {
    setLoadingRemoteLogs(true)
    setRemoteLogError(null)
    try {
      const result = await panelBridgeApi.listSftpLogs({
        ...sftpConfig(),
        logPath: settings.panelBridgeSftpLogPath,
      })
      setRemoteLogs(result.files || [])
      if (!result.files?.length) {
        setRemoteLogError('No .txt or .log files found in that folder.')
      }
    } catch (error) {
      setRemoteLogs([])
      setRemoteLogError(
        getUserErrorMessage(error, 'Could not list remote logs.'),
      )
    } finally {
      setLoadingRemoteLogs(false)
    }
  }

  const handleCheckRemoteConfig = async () => {
    setLoadingRemoteConfig(true)
    setRemoteConfigError(null)
    try {
      const result = await panelBridgeApi.listSftpConfigFiles({
        ...sftpConfig(),
        configPath: settings.panelBridgeSftpConfigPath,
      })
      setRemoteConfigFiles(result.files || [])
      if (!result.files?.length) {
        setRemoteConfigError(
          "No .ini or .lua files found in that folder. Check the path points at the server's Server folder.",
        )
      }
    } catch (error) {
      setRemoteConfigFiles([])
      setRemoteConfigError(
        getUserErrorMessage(error, 'Could not read the remote config folder.'),
      )
    } finally {
      setLoadingRemoteConfig(false)
    }
  }

  const handleTailRemoteLog = async (name: string) => {
    setLoadingRemoteLogs(true)
    setRemoteLogError(null)
    try {
      const result = await panelBridgeApi.tailSftpLog({
        ...sftpConfig(),
        logPath: settings.panelBridgeSftpLogPath,
        name,
      })
      setRemoteLogContent({
        name: result.name,
        content: result.content,
        truncated: result.truncated,
        bytesReturned: result.bytesReturned,
      })
    } catch (error) {
      setRemoteLogContent(null)
      setRemoteLogError(
        getUserErrorMessage(error, 'Could not read that log file.'),
      )
    } finally {
      setLoadingRemoteLogs(false)
    }
  }

  const handleTestSftp = async () => {
    setTestingSftp(true)
    try {
      const result = await panelBridgeApi.testSftp(sftpConfig())
      toast({
        title: result.statusExists ? 'SFTP Bridge Ready' : 'SFTP Folders Ready',
        description: `${result.nextStep} (${result.latencyMs} ms)`,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'SFTP Test Failed',
        description: getUserErrorMessage(error, 'Could not connect to SFTP.'),
        variant: 'destructive',
      })
    } finally {
      setTestingSftp(false)
    }
  }

  const handleConfigureSftp = async () => {
    setBridgeLoading(true)
    setBridgeError(null)
    try {
      await panelBridgeApi.configureSftp(sftpConfig())
      updateSetting('panelBridgeSftpEnabled', true)
      setOriginalSettings((previous) =>
        previous
          ? {
              ...previous,
              panelBridgeSftpEnabled: true,
              panelBridgeSftpHost: settings.panelBridgeSftpHost,
              panelBridgeSftpPort: settings.panelBridgeSftpPort,
              panelBridgeSftpUsername: settings.panelBridgeSftpUsername,
              panelBridgeSftpPassword: settings.panelBridgeSftpPassword,
              panelBridgeSftpBridgePath: settings.panelBridgeSftpBridgePath,
              panelBridgeSftpPollIntervalSeconds:
                settings.panelBridgeSftpPollIntervalSeconds,
            }
          : previous,
      )
      toast({
        title: 'SFTP Bridge Started',
        description: 'PanelBridge is syncing through the local cache.',
        variant: 'success' as const,
      })
      await fetchBridgeStatus()
    } catch (error) {
      if (originalSettings) {
        setSettings((previous) => ({
          ...previous,
          panelBridgeSftpEnabled: originalSettings.panelBridgeSftpEnabled,
          panelBridgeSftpHost: originalSettings.panelBridgeSftpHost,
          panelBridgeSftpPort: originalSettings.panelBridgeSftpPort,
          panelBridgeSftpUsername: originalSettings.panelBridgeSftpUsername,
          panelBridgeSftpPassword: originalSettings.panelBridgeSftpPassword,
          panelBridgeSftpBridgePath: originalSettings.panelBridgeSftpBridgePath,
          panelBridgeSftpPollIntervalSeconds:
            originalSettings.panelBridgeSftpPollIntervalSeconds,
        }))
      }
      setBridgeError(
        getUserErrorMessage(error, 'Could not start the SFTP bridge.'),
      )
    } finally {
      setBridgeLoading(false)
    }
  }

  const handlePingMod = async () => {
    setPinging(true)
    try {
      const result = await panelBridgeApi.ping()
      toast({
        title: 'Mod Connected!',
        description:
          'Connected to ' + String(result.modStatus?.serverName || 'server'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Mod Did Not Respond',
        description: getUserErrorMessage(
          error,
          'No response from PanelBridge.lua. Make sure the game server is running and the mod is enabled.',
        ),
        variant: 'destructive',
        action: (
          <ToastAction
            altText={'Open PanelBridge settings'}
            onClick={() => handleTabChange('bridge')}
          >
            {'Open Bridge'}
          </ToastAction>
        ),
      })
    } finally {
      setPinging(false)
    }
  }

  const updateSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    if (
      typeof value === 'string' &&
      [
        'modCheckInterval',
        'modRestartDelay',
        'reconnectInterval',
        'panelPort',
        'httpsPort',
        'panelBridgeSftpPort',
        'panelBridgeSftpPollIntervalSeconds',
      ].includes(key)
    ) {
      if (value !== '' && isNaN(parseInt(value))) {
        return
      }
    }
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const [pendingCorsLanDisable, setPendingCorsLanDisable] = useState(false)
  const handleCorsLanToggle = (value: boolean) => {
    if (
      !value &&
      !settings.corsAllowAll &&
      !settings.corsAllowedOrigins.trim()
    ) {
      setPendingCorsLanDisable(true)
      return
    }
    updateSetting('corsAllowPrivateNetworks', value)
  }

  const selectedInstallServer =
    servers.find((server) => String(server.id) === selectedInstallServerId) ||
    null
  const activeServer = servers.find((server) => server.isActive) || null
  const isRemoteServer = Boolean(activeServer?.isRemote)
  const trimmedHttpsKeyPath = settings.httpsKeyPath.trim()
  const trimmedHttpsCertPath = settings.httpsCertPath.trim()
  const hasPartialHttpsCertPath =
    Boolean(trimmedHttpsKeyPath) !== Boolean(trimmedHttpsCertPath)
  const usingAutoGeneratedHttpsCert =
    settings.httpsEnabled && !trimmedHttpsKeyPath && !trimmedHttpsCertPath
  const httpsPortPreview = normalizePort(settings.httpsPort || '3443')
  const httpPortPreview = normalizePort(settings.panelPort || '3001')
  const httpsPreviewUrl = `https://${window.location.hostname}:${httpsPortPreview}`
  const httpPreviewUrl = `http://${window.location.hostname}:${httpPortPreview}`

  const applyRecommendedHttpsDefaults = () => {
    updateSetting('httpsEnabled', true)
    updateSetting('httpsPort', '3443')
    updateSetting('httpsKeyPath', '')
    updateSetting('httpsCertPath', '')
  }

  const sep = selectedInstallServer?.installPath?.includes('\\') ? '\\' : '/'
  const selectedInstallTarget = selectedInstallServer
    ? `${selectedInstallServer.installPath}${sep}media${sep}lua${sep}server${sep}PanelBridge.lua`
    : null

  useEffect(() => {
    let cancelled = false

    if (!authEnabled) {
      setLocalPasswordResetSupported(false)
      setShowLocalPasswordReset(false)
      return () => {
        cancelled = true
      }
    }

    fetch('/api/auth/reset-status')
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        setLocalPasswordResetSupported(data.localResetSupported === true)
      })
      .catch(() => {
        if (cancelled) return
        setLocalPasswordResetSupported(false)
      })

    return () => {
      cancelled = true
    }
  }, [authEnabled])

  const handleChangePassword = async () => {
    if (!newPassword || !confirmPassword) return
    if (newPassword !== confirmPassword) {
      toast({ title: 'Passwords do not match', variant: 'destructive' })
      return
    }
    if (newPassword.length < 6) {
      toast({
        title: 'Password must be at least 6 characters',
        variant: 'destructive',
      })
      return
    }
    setChangingPassword(true)
    try {
      await authApi.changePassword(currentPassword, newPassword)
      toast({
        title: 'Password Changed',
        description: 'Your password has been updated.',
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (error) {
      toast({
        title: 'Change Password Failed',
        description: getUserErrorMessage(
          error,
          'The panel could not change your password. Check your current password and try again.',
        ),
        variant: 'destructive',
      })
    } finally {
      setChangingPassword(false)
    }
  }

  const handleRegenerateJwtSecret = async () => {
    setRegeneratingJwtSecret(true)
    try {
      await authApi.regenerateJwtSecret()
      setRegenerateJwtDialogOpen(false)
      toast({
        title: 'JWT secret regenerated',
        description:
          'Every session has been signed out, including this one. Redirecting to sign-in…',
      })
      await logout()
    } catch (error) {
      toast({
        title: 'Regeneration failed',
        description: getUserErrorMessage(
          error,
          'The panel could not regenerate the JWT secret.',
        ),
        variant: 'destructive',
      })
    } finally {
      setRegeneratingJwtSecret(false)
    }
  }

  const handlePrepareLocalPasswordReset = async () => {
    setPreparingLocalPasswordReset(true)
    try {
      const response = await fetch('/api/auth/reset-token/local', {
        method: 'POST',
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(
          data.error ||
            'The panel could not prepare password recovery on this server.',
        )
      }

      setLocalPasswordResetSupported(true)
      setShowLocalPasswordReset(true)
      setLocalPasswordResetToken('')
      toast({
        title: 'Recovery Ready',
        description:
          typeof data.message === 'string'
            ? data.message
            : 'Recovery token created at data/reset-token.txt. Paste it below to continue.',
      })
    } catch (error) {
      toast({
        title: 'Recovery Unavailable',
        description: getUserErrorMessage(
          error,
          'The panel could not prepare password recovery on this server.',
        ),
        variant: 'destructive',
      })
    } finally {
      setPreparingLocalPasswordReset(false)
    }
  }

  const handleResetLostPassword = async () => {
    if (!localPasswordResetToken) {
      toast({ title: 'Recovery token missing', variant: 'destructive' })
      return
    }
    if (!localPasswordResetPassword || !localPasswordResetConfirm) return
    if (localPasswordResetPassword !== localPasswordResetConfirm) {
      toast({ title: 'Passwords do not match', variant: 'destructive' })
      return
    }
    if (localPasswordResetPassword.length < 6) {
      toast({
        title: 'Password must be at least 6 characters',
        variant: 'destructive',
      })
      return
    }

    setResettingLocalPassword(true)
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: localPasswordResetToken,
          newPassword: localPasswordResetPassword,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(
          data.error ||
            'The panel could not reset your password from this server.',
        )
      }

      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setShowLocalPasswordReset(false)
      setLocalPasswordResetToken('')
      setLocalPasswordResetPassword('')
      setLocalPasswordResetConfirm('')
      toast({
        title: 'Password Reset',
        description:
          'Your password has been reset. Sign in again with the new password.',
      })
      await logout()
    } catch (error) {
      toast({
        title: 'Password Reset Failed',
        description: getUserErrorMessage(
          error,
          'The panel could not reset your password from this server.',
        ),
        variant: 'destructive',
      })
    } finally {
      setResettingLocalPassword(false)
    }
  }

  if (loading && !originalSettings) {
    return (
      <PageSkeleton
        variant="form"
        eyebrow={'Configuration'}
        title={'Settings'}
        description={
          'Panel port, remote access, server integrations, backups, and security.'
        }
      />
    )
  }

  if (settingsLoadError && !originalSettings) {
    return (
      <div className="page-transition">
        <PageHeader
          title={'Settings'}
          description={
            'Panel port, remote access, server integrations, backups, and security.'
          }
          eyebrow={'Configuration'}
          tone="config"
          icon={<Settings2 className="w-5 h-5" />}
        />
        <Card className="border-2 border-destructive/50 bg-destructive/5 mt-4">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-6 h-6 text-destructive shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold">
                  {"Couldn't load settings"}
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {String(settingsLoadError) +
                    ' — showing your last-saved settings would risk overwriting real values with placeholders, so nothing is editable until this loads.'}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchSettings}
                disabled={loading}
              >
                <RefreshCw
                  className={cn('w-4 h-4 me-2', loading && 'animate-spin')}
                />
                {'Retry'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="page-transition">
      <AutoUpdateResultBanner />
      {isDirty && (
        <div
          role="status"
          aria-live="polite"
          className="relative mb-5 overflow-hidden rounded-lg border border-warning/45 bg-warning/[0.08] shadow-sm"
        >
          <div
            className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-warning via-warning/80 to-warning/30"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-3 p-4 ps-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-warning/40 bg-warning/15 text-warning">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="relative inline-flex w-2 h-2"
                    aria-hidden="true"
                  >
                    <span className="absolute inset-0 rounded-full bg-warning/50 animate-ping motion-reduce:hidden" />
                    <span className="relative w-2 h-2 rounded-full bg-warning" />
                  </span>
                  <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-warning">
                    {'Unsaved changes'}
                  </p>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {
                    'You have pending edits. Save changes to apply them to the live panel.'
                  }
                </p>
              </div>
            </div>
            <Button
              onClick={handleSave}
              disabled={saving || Boolean(corsOriginValidationError)}
              size="sm"
              variant="warning"
              className="self-start gap-2 sm:self-auto"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {'Save Changes'}
            </Button>
          </div>
        </div>
      )}

      <PageHeader
        title={'Settings'}
        description={
          settingsSections.find((s) => s.id === activeSection)?.description ??
          'Panel port, remote access, server integrations, backups, and security.'
        }
        eyebrow={'Configuration'}
        tone="config"
        icon={<Settings2 className="w-5 h-5" />}
        actions={
          <Button
            variant="command"
            onClick={handleSave}
            disabled={saving || !isDirty || Boolean(corsOriginValidationError)}
            size="lg"
            className="w-full sm:w-auto gap-2"
          >
            {saving ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Save className="w-5 h-5" />
            )}
            {saving
              ? 'Saving...'
              : isDirty
                ? 'Save Settings'
                : 'No Unsaved Changes'}
          </Button>
        }
      />

      <Tabs
        value={activeSection}
        onValueChange={handleTabChange}
        className="mt-6 lg:grid lg:grid-cols-[14.5rem_minmax(0,1fr)] lg:items-start lg:gap-7"
      >
        <div className="relative lg:contents">
          <TabsList
            aria-label={'Settings sections'}
            className="mb-4 flex h-auto w-full max-w-full justify-start gap-1 overflow-x-auto rounded-md border border-border/50 bg-muted/30 p-1 lg:sticky lg:top-4 lg:order-1 lg:mb-0 lg:flex-col lg:items-stretch lg:gap-px lg:overflow-visible lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0"
          >
            {settingsGroups.map((group) => (
              <React.Fragment key={group.name}>
                <p
                  role="presentation"
                  className="hidden lg:block px-2 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60 lg:first:pt-0"
                >
                  {group.name}
                </p>
                {group.sections.map((section) => {
                  const Icon = section.icon
                  return (
                    <Tooltip key={section.id}>
                      <TooltipTrigger asChild>
                        <TabsTrigger
                          value={section.id}
                          className="settings-tab-trigger shrink-0 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none lg:w-full lg:justify-start lg:px-2.5"
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                          <span className="truncate">{section.label}</span>
                        </TabsTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-[220px]">
                        <p className="text-xs">{section.tip}</p>
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </React.Fragment>
            ))}
          </TabsList>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 end-0 flex w-10 items-center justify-end rounded-e-md bg-gradient-to-l rtl:bg-gradient-to-r from-muted to-transparent pe-1.5 lg:hidden"
          >
            <ChevronRight className="h-4 w-4 text-muted-foreground/80 rtl:-scale-x-100" />
          </div>
        </div>

        <div className="space-y-5 lg:order-2">
          <TabsContent value="general" className="mt-0">
            <Card id="settings-general">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-primary" />
                  {'Panel Settings'}
                </CardTitle>
                <CardDescription>
                  {'Port this panel listens on, and how it looks.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="max-w-xs">
                  <Label htmlFor="panel-port">{'Panel Port'}</Label>
                  <Input
                    id="panel-port"
                    type="number"
                    value={settings.panelPort}
                    onChange={(e) => updateSetting('panelPort', e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()}
                    min="1024"
                    max="65535"
                    placeholder="3001"
                    inputMode="numeric"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {'Port used to access the panel (default: 3001).'}
                  </p>
                </div>
                {originalSettings &&
                  settings.panelPort !== originalSettings.panelPort && (
                    <Alert className="border-warning/40 bg-warning/10">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {'Restart Required'}
                      </AlertTitle>
                      <AlertDescription>
                        {
                          'Port changes require a restart. Save first, then restart.'
                        }
                      </AlertDescription>
                    </Alert>
                  )}
                <div className="flex items-center gap-3">
                  <AlertDialog
                    open={restartConfirmOpen}
                    onOpenChange={(open) => {
                      setRestartConfirmOpen(open)
                      if (!open) setRestartRiskConfirmed(false)
                    }}
                  >
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        disabled={restarting || isDirty}
                        className="gap-2"
                      >
                        {restarting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RotateCw className="w-4 h-4" />
                        )}
                        {restarting ? 'Restarting...' : 'Restart Panel'}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {'Restart the panel?'}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {restartAssessmentMessage(
                            panelRestartAssessment,
                            'general',
                          )}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      {panelRestartIsRisky && (
                        <label className="flex items-start gap-2 text-sm">
                          <Checkbox
                            checked={restartRiskConfirmed}
                            onCheckedChange={(checked) =>
                              setRestartRiskConfirmed(checked === true)
                            }
                          />
                          <span>
                            {
                              'I understand that running game servers may be stopped.'
                            }
                          </span>
                        </label>
                      )}
                      <AlertDialogFooter>
                        <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
                        <AlertDialogAction
                          disabled={
                            panelRestartIsRisky && !restartRiskConfirmed
                          }
                          onClick={() =>
                            restartPanelWithReconnect(
                              'Panel is restarting on port ' +
                                String(settings.panelPort) +
                                '. Reconnecting...',
                            )
                          }
                        >
                          {'Restart Panel'}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  {isDirty && (
                    <p className="text-xs text-muted-foreground">
                      {'Save settings before restarting'}
                    </p>
                  )}
                </div>

                <div className="rounded-xl border border-border/70 bg-background/40 p-4 space-y-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium flex items-center gap-2">
                      <Palette className="w-4 h-4 text-primary" />
                      {'Appearance'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {'Panel theme and visual style.'}
                    </p>
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">{'Theme'}</Label>
                      <p className="text-xs text-muted-foreground">
                        {
                          'Choose between the gritty survival look or a clean light theme.'
                        }
                      </p>
                    </div>
                    <ThemeSelect />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="access" className="mt-0">
            <div className="rounded-xl border border-border/70 bg-background/40 p-4 space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">{'Remote Access (CORS)'}</p>
                <p className="text-xs text-muted-foreground">
                  {
                    'Controls which devices and browsers can connect to this panel. If you only access the panel from this machine, these defaults are fine.'
                  }
                </p>
              </div>

              <Alert className="border-border/60 bg-muted/40">
                <Globe className="h-4 w-4 text-primary" />
                <AlertTitle>{'Quick Start for VPS Remote Access'}</AlertTitle>
                <AlertDescription className="space-y-1 text-sm text-muted-foreground">
                  <p>
                    <>
                      {'1. Keep '}
                      <strong className="text-foreground">
                        {'Allow private/LAN origins'}
                      </strong>
                      {' on.'}
                    </>
                  </p>
                  <p>
                    <>
                      {
                        '2. Add one origin per line in the list below (example: '
                      }
                      <code>{'http://YOUR_PUBLIC_IP:3001'}</code>
                      {').'}
                    </>
                  </p>
                  <p>
                    <>
                      {'3. Save settings, then click '}
                      <strong className="text-foreground">
                        {'Reload CORS Rules'}
                      </strong>
                      {'.'}
                    </>
                  </p>
                </AlertDescription>
              </Alert>

              <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                <div>
                  <Label className="text-sm font-medium">
                    {'Allow Private/LAN Origins'}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {
                      'Automatically allow connections from localhost and private/LAN IP ranges.'
                    }
                  </p>
                </div>
                <Switch
                  checked={settings.corsAllowPrivateNetworks}
                  onCheckedChange={handleCorsLanToggle}
                  aria-label={'Allow private and LAN origins'}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                <div>
                  <Label className="text-sm font-medium">
                    {'Show Public IP Address'}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {
                      "Look up this machine's public IP (via api.ipify.org) to display on the dashboard. Off by default — an unnecessary external dependency and small privacy leak for LAN-only setups. The result is cached, so this calls out at most once per restart."
                    }
                  </p>
                </div>
                <Switch
                  checked={settings.enablePublicIpLookup}
                  onCheckedChange={(value) =>
                    updateSetting('enablePublicIpLookup', value)
                  }
                  aria-label={'Enable public IP lookup'}
                />
              </div>

              <div className="space-y-2 rounded-lg border border-border/60 bg-muted/25 p-3">
                <div>
                  <Label className="text-sm font-medium">
                    {'Dashboard LAN Address'}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {
                      "Which network interface's address the dashboard shows. Useful when this host has more than one, e.g. Tailscale and ZeroTier at once — pick the one you actually want to share with players."
                    }
                  </p>
                </div>
                <Select
                  value={settings.lanIpAddress || 'auto'}
                  onValueChange={(value) =>
                    updateSetting('lanIpAddress', value === 'auto' ? '' : value)
                  }
                >
                  <SelectTrigger aria-label={'Dashboard LAN address'}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {'Auto-detect (default)'}
                    </SelectItem>
                    {networkInterfaces.map((iface) => (
                      <SelectItem key={iface.address} value={iface.address}>
                        {iface.name} — {iface.address}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="cors-origins">
                    {'Additional Allowed Origins'}
                  </Label>
                  <HelpTip label={'Additional Allowed Origins'}>
                    {
                      "Browsers block a page from talking to an API at a different address than the one it was loaded from. If you open this panel from an address it doesn't already recognize — a domain name, a reverse proxy, a second network interface — add that exact address here or the browser will silently refuse its requests. Most single-machine setups never need this."
                    }
                  </HelpTip>
                </div>
                <Textarea
                  id="cors-origins"
                  value={settings.corsAllowedOrigins}
                  onChange={(e) =>
                    updateSetting('corsAllowedOrigins', e.target.value)
                  }
                  placeholder={
                    'http://123.45.67.89:3001\nhttps://panel.example.com'
                  }
                  rows={4}
                />
                <p className="text-xs text-muted-foreground">
                  {
                    'One address per line, including http:// or https:// and port if needed.'
                  }
                </p>
                {corsOriginValidationError && (
                  <p className="text-xs text-destructive">
                    {corsOriginValidationError}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between rounded-lg border border-warning/40 bg-warning/10 p-3">
                <div>
                  <Label className="text-sm font-medium text-warning">
                    {'Allow All Origins (Debug Only)'}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {
                      'Skip all origin checks — useful for diagnosing connection problems.'
                    }
                  </p>
                </div>
                <Switch
                  checked={settings.corsAllowAll}
                  onCheckedChange={(value) =>
                    updateSetting('corsAllowAll', value)
                  }
                  aria-label={'Allow all origins'}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                <div>
                  <Label className="text-sm font-medium">
                    {'Enable CORS Debug Logging'}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {'Log blocked connection attempts for troubleshooting.'}
                  </p>
                </div>
                <Switch
                  checked={settings.corsDebug}
                  onCheckedChange={(value) => updateSetting('corsDebug', value)}
                  aria-label={'Enable CORS debug logging'}
                />
              </div>

              {settings.corsAllowAll && (
                <Alert className="border-warning/40 bg-warning/10">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  <AlertTitle className="text-warning">
                    {'Security Warning'}
                  </AlertTitle>
                  <AlertDescription>
                    {
                      'Allowing all origins removes browser-origin protection. Use this only for short troubleshooting windows.'
                    }
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleReloadCorsRules}
                  disabled={
                    corsUpdating || saving || Boolean(corsOriginValidationError)
                  }
                  className="gap-2"
                >
                  {corsUpdating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  {'Reload CORS Rules'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={fetchCorsDiagnostics}
                  disabled={corsLoading || corsUpdating}
                  className="gap-2"
                >
                  <RefreshCw
                    className={cn('w-4 h-4', corsLoading && 'animate-spin')}
                  />
                  {'Refresh Diagnostics'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearCorsBlocked}
                  disabled={corsUpdating || !corsDiagnostics?.blockedCount}
                  className="gap-2 text-muted-foreground"
                >
                  <Trash2 className="w-4 h-4" />
                  {'Clear Blocked Log'}
                </Button>
              </div>

              <div className="grid gap-3 text-xs sm:grid-cols-3">
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                  <p className="text-muted-foreground">{'Blocked Origins'}</p>
                  <p className="mt-1 font-medium text-foreground">
                    {corsDiagnostics?.blockedCount ?? 0}
                  </p>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                  <p className="text-muted-foreground">
                    {'Effective Allowlist'}
                  </p>
                  <p className="mt-1 font-medium text-foreground">
                    {corsDiagnostics?.effectiveAllowedOrigins.length ?? 0}
                  </p>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                  <p className="text-muted-foreground">{'Last Reload'}</p>
                  <p className="mt-1 font-medium text-foreground">
                    {formatTimestamp(corsDiagnostics?.lastLoadedAt || null)}
                  </p>
                </div>
              </div>

              {!!corsDiagnostics?.blocked.length && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-foreground">
                    {'Recent Blocked Origins'}
                  </p>
                  <ScrollArea className="h-[150px] rounded-lg border border-border/60 bg-muted/20 p-2">
                    <div className="space-y-2 pe-2">
                      {corsDiagnostics.blocked.slice(0, 12).map((entry) => (
                        <div
                          key={entry.id}
                          className="rounded-md border border-border/50 bg-background/60 px-2 py-1.5 text-xs"
                        >
                          <p className="font-mono break-all text-foreground">
                            {entry.origin}
                          </p>
                          <p className="text-muted-foreground">
                            {entry.source.toUpperCase()} •{' '}
                            {formatTimestamp(entry.blockedAt)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="updates" className="mt-0">
            <div className="rounded-xl border border-border/70 bg-muted/30 p-4 space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{'Panel Auto Update'}</p>
                  <p className="text-xs text-muted-foreground">
                    {
                      'Check for a new release, download it, then apply on restart.'
                    }
                  </p>
                </div>
                {checkingPanelUpdate || panelUpdateStatus?.isChecking ? (
                  <span className="inline-flex items-center rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5 text-xs font-semibold text-foreground/85">
                    {'Checking...'}
                  </span>
                ) : downloadingPanelUpdate ||
                  panelUpdateStatus?.isDownloading ? (
                  <span className="inline-flex items-center rounded-full border border-primary/35 bg-primary/12 px-2.5 py-0.5 text-xs font-semibold text-primary">
                    {'Downloading...'}
                  </span>
                ) : panelUpdateStatus?.updateAvailable ? (
                  <span className="inline-flex items-center rounded-full border border-warning/35 bg-warning/12 px-2.5 py-0.5 text-xs font-semibold text-warning">
                    {'Update available'}
                  </span>
                ) : panelUpdateStatusError ? (
                  <span className="inline-flex items-center rounded-full border border-destructive/35 bg-destructive/12 px-2.5 py-0.5 text-xs font-semibold text-destructive">
                    {'Cannot reach updater'}
                  </span>
                ) : !panelUpdateStatus?.latestVersion ? (
                  <span className="inline-flex items-center rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5 text-xs font-semibold text-foreground/80">
                    {'Not checked'}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
                    {'Up to date'}
                  </span>
                )}
              </div>

              {panelUpdateStatusError && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{'Updater Error'}</AlertTitle>
                  <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span className="break-words">
                      {panelUpdateStatusError}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={fetchPanelUpdateStatus}
                      disabled={
                        checkingPanelUpdate ||
                        downloadingPanelUpdate ||
                        restarting
                      }
                      className="self-start"
                    >
                      {'Retry'}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-3 text-xs sm:grid-cols-2">
                <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                  <p className="text-muted-foreground">{'Installed'}</p>
                  <p className="mt-1 font-medium text-foreground">
                    v{panelUpdateStatus?.currentVersion || 'Unknown'}
                  </p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                  <p className="text-muted-foreground">{'Latest'}</p>
                  <p className="mt-1 font-medium text-foreground">
                    {panelUpdateStatus?.latestVersion
                      ? `v${panelUpdateStatus.latestVersion}`
                      : 'Not checked yet'}
                  </p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                  <p className="text-muted-foreground">{'Last Check'}</p>
                  <p className="mt-1 font-medium text-foreground">
                    {formatTimestamp(panelUpdateStatus?.lastCheck || null)}
                  </p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                  <p className="text-muted-foreground">{'Release Published'}</p>
                  <p className="mt-1 font-medium text-foreground">
                    {formatTimestamp(panelUpdateStatus?.publishedAt || null)}
                  </p>
                </div>
              </div>

              {(downloadingPanelUpdate || panelUpdateStatus?.isDownloading) && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{'Downloading update'}</span>
                    <span>{panelUpdateStatus?.downloadProgress ?? 0}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full w-full bg-primary transition-transform duration-200 ease-out"
                      style={{
                        transform: `translateX(-${100 - (panelUpdateStatus?.downloadProgress ?? 0)}%)`,
                      }}
                    />
                  </div>
                </div>
              )}

              {panelUpdateStatus?.lastError && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{'Last Update Error'}</AlertTitle>
                  <AlertDescription className="break-words whitespace-pre-wrap">
                    {panelUpdateStatus.lastError}
                  </AlertDescription>
                </Alert>
              )}

              {panelUpdateStatus?.lastApplyResult &&
                !panelApplyResultDismissed &&
                (panelUpdateStatus.lastApplyResult.status === 'success' ? (
                  (panelUpdateStatus.lastApplyResult.appliedVersion &&
                    panelUpdateStatus.currentVersion &&
                    panelUpdateStatus.lastApplyResult.appliedVersion !==
                      panelUpdateStatus.currentVersion) ||
                  panelUpdateStatus.stagedUpdate ? null : (
                    <Alert variant="success">
                      <AlertTitle>{'Update Applied'}</AlertTitle>
                      <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <span>
                          {'Panel is now running v' +
                            String(
                              panelUpdateStatus.lastApplyResult
                                .appliedVersion ||
                                panelUpdateStatus.currentVersion,
                            ) +
                            String(
                              panelUpdateStatus.lastApplyResult.at
                                ? ' (applied ' +
                                    String(
                                      formatTimestamp(
                                        panelUpdateStatus.lastApplyResult.at,
                                      ),
                                    ) +
                                    ')'
                                : '',
                            ) +
                            '.'}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPanelApplyResultDismissed(true)}
                          className="self-start"
                        >
                          {'Dismiss'}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )
                ) : (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>{'Update Failed to Apply'}</AlertTitle>
                    <AlertDescription className="flex flex-col gap-2">
                      <span className="break-words">
                        {'Panel is still running v' +
                          String(
                            panelUpdateStatus.lastApplyResult.currentVersion ||
                              panelUpdateStatus.currentVersion,
                          ) +
                          '.'}
                        {panelUpdateStatus.lastApplyResult.pendingVersion
                          ? ' Expected v' +
                            String(
                              panelUpdateStatus.lastApplyResult.pendingVersion,
                            ) +
                            '.'
                          : ''}
                        {panelUpdateStatus.lastApplyResult.stagedStillPresent
                          ? ' The downloaded file is still on disk; you can retry the restart.'
                          : ' The staged binary is gone — re-download the update before retrying.'}
                      </span>
                      {panelUpdateStatus.lastApplyResult.likelyCause ===
                        'av_quarantine' &&
                        runtimeInfo?.family === 'windows' && (
                          <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                            <strong className="text-destructive-foreground">
                              {'Likely cause:'}
                            </strong>{' '}
                            {
                              'antivirus or Controlled Folder Access deleted the new binary after it was placed.'
                            }
                            {panelUpdateStatus.lastApplyResult.panelFolder && (
                              <div className="mt-1">
                                {
                                  'Add this folder to your AV exclusions and retry:'
                                }
                                <pre className="mt-1 rounded bg-background/70 p-1 text-[11px]">
                                  {
                                    panelUpdateStatus.lastApplyResult
                                      .panelFolder
                                  }
                                </pre>
                                <div className="mt-1 text-[11px] opacity-80">
                                  {'Windows Defender:'}{' '}
                                  <code>
                                    Add-MpPreference -ExclusionPath{' '}
                                    {JSON.stringify(
                                      panelUpdateStatus.lastApplyResult
                                        .panelFolder,
                                    )}
                                  </code>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      {panelUpdateStatus.lastApplyResult.likelyCause ===
                        'rename_locked' && (
                        <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                          <strong className="text-destructive-foreground">
                            {'Likely cause:'}
                          </strong>{' '}
                          {
                            'another process (OneDrive, AV, or a file watcher) held the exe locked. Pause OneDrive or close explorer windows pointing at the folder, then retry.'
                          }
                        </div>
                      )}
                      {panelUpdateStatus.lastApplyResult.likelyCause ===
                        'permission' && (
                        <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                          <strong className="text-destructive-foreground">
                            {'Likely cause:'}
                          </strong>{' '}
                          {runtimeInfo?.family === 'windows'
                            ? 'access denied writing to the panel folder. Relaunch the panel as Administrator or move it out of Program Files.'
                            : runtimeInfo?.family === 'posix'
                              ? 'access denied writing to the panel folder. Check ownership and write permissions for the panel service user.'
                              : 'access denied writing to the panel folder. Check the permissions for the account running the panel.'}
                        </div>
                      )}
                      {panelUpdateStatus.lastApplyResult.likelyCause ===
                        'helper_blocked' &&
                        runtimeInfo?.family === 'windows' && (
                          <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                            <strong className="text-destructive-foreground">
                              {'Likely cause:'}
                            </strong>{' '}
                            {
                              'the update helper script was blocked from running (Windows Defender ASR, AppLocker, or Group Policy). The staged binary is still on disk.'
                            }
                            {panelUpdateStatus.lastApplyResult.panelFolder && (
                              <div className="mt-1">
                                <strong>{'Recovery:'}</strong>{' '}
                                <>
                                  {'close this panel and double-click '}
                                  <code>{'Start.bat'}</code>
                                  {' in:'}
                                </>
                                <pre className="mt-1 rounded bg-background/70 p-1 text-[11px]">
                                  {
                                    panelUpdateStatus.lastApplyResult
                                      .panelFolder
                                  }
                                </pre>
                                <div className="mt-1 text-[11px] opacity-80">
                                  {
                                    'Start.bat picks the newest binary automatically, so the update will apply. To prevent this in the future, add the panel folder to AV exclusions.'
                                  }
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      {panelUpdateStatus.lastApplyResult.likelyCause ===
                        'no_helper_log' && (
                        <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                          <strong className="text-destructive-foreground">
                            {'No helper log was written.'}
                          </strong>{' '}
                          {
                            'The helper script may have been blocked by execution policy or AV. Check Windows Defender protection history.'
                          }
                        </div>
                      )}
                      {panelUpdateStatus.lastApplyResult.likelyCause ===
                        'rollback_failed' &&
                        runtimeInfo?.family === 'windows' && (
                          <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                            <strong className="text-destructive-foreground">
                              {'Likely cause:'}
                            </strong>{' '}
                            {panelUpdateStatus.lastApplyResult
                              .rollbackRetryLikely
                              ? 'the automatic rollback did not fully complete. The panel is likely to retry this exact update again on the next restart and fail the same way, until this is cleared by hand.'
                              : 'the update rolled back successfully. One leftover file could not be removed automatically and is safe to delete by hand.'}
                            {panelUpdateStatus.lastApplyResult.panelFolder && (
                              <div className="mt-1">
                                <strong>{'Files to delete:'}</strong>{' '}
                                {panelUpdateStatus.lastApplyResult
                                  .rollbackRetryLikely
                                  ? 'close this panel first, then delete these three files from the install folder below:'
                                  : 'delete this file from the install folder below:'}
                                <pre className="mt-1 rounded bg-background/70 p-1 text-[11px]">
                                  {panelUpdateStatus.lastApplyResult
                                    .rollbackRetryLikely
                                    ? '.update-pending\n.update-applying\nupdate-bundle.json'
                                    : 'update-bundle.json'}
                                </pre>
                                <div className="mt-1 text-[11px] opacity-80">
                                  {
                                    panelUpdateStatus.lastApplyResult
                                      .panelFolder
                                  }
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      {panelApplyLog && (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer font-medium">
                            {'Show helper log'}
                          </summary>
                          <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-destructive/30 bg-background/60 p-2 text-[11px] leading-snug whitespace-pre-wrap break-all">
                            {panelApplyLog}
                          </pre>
                        </details>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPanelApplyResultDismissed(true)}
                        >
                          {'Dismiss'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            try {
                              const { log: helperLog } =
                                await panelUpdateApi.getApplyLog()
                              setPanelApplyLog(
                                helperLog || 'No helper log found.',
                              )
                            } catch (error) {
                              toast({
                                title: 'Could not read log',
                                description: getUserErrorMessage(
                                  error,
                                  'Failed to read helper log.',
                                ),
                                variant: 'destructive',
                              })
                            }
                          }}
                        >
                          {'Refresh log'}
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                ))}

              {panelUpdatePreflight &&
                !panelUpdatePreflight.ok &&
                (panelUpdateStatus?.updateAvailable ||
                  panelUpdateStatus?.stagedUpdate) && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>{'Update Blocked'}</AlertTitle>
                    <AlertDescription>
                      <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
                        {translatePanelUpdateMessages(
                          panelUpdatePreflight.blockers,
                          panelUpdatePreflight.blockerDetails,
                        ).map((b, i) => (
                          <li key={`blk-${i}`} className="break-words">
                            {b}
                          </li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

              {panelUpdatePreflight &&
                panelUpdatePreflight.ok &&
                panelUpdatePreflight.warnings.length > 0 &&
                (panelUpdateStatus?.updateAvailable ||
                  panelUpdateStatus?.stagedUpdate) &&
                !(
                  panelUpdateStatus?.lastApplyResult?.status === 'failed' &&
                  !panelApplyResultDismissed
                ) && (
                  <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>{'Before You Restart'}</AlertTitle>
                    <AlertDescription>
                      <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
                        {translatePanelUpdateMessages(
                          panelUpdatePreflight.warnings,
                          panelUpdatePreflight.warningDetails,
                        ).map((w, i) => (
                          <li key={`wrn-${i}`} className="break-words">
                            {w}
                          </li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={handleCheckPanelUpdate}
                  disabled={
                    checkingPanelUpdate || downloadingPanelUpdate || restarting
                  }
                  className="gap-2"
                >
                  {checkingPanelUpdate ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  {checkingPanelUpdate ? 'Checking...' : 'Check for Updates'}
                </Button>

                {isDockerPanelUpdate ? (
                  <AlertDialog
                    open={dockerUpdateConfirmOpen}
                    onOpenChange={setDockerUpdateConfirmOpen}
                  >
                    <AlertDialogTrigger asChild>
                      <Button
                        disabled={
                          !panelUpdateStatus?.updateAvailable ||
                          checkingPanelUpdate ||
                          downloadingPanelUpdate ||
                          restarting ||
                          panelUpdatePreflight?.ok === false
                        }
                        className="gap-2"
                      >
                        {downloadingPanelUpdate ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                        {downloadingPanelUpdate
                          ? 'Applying Docker Update...'
                          : 'Apply Docker Update'}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {'Apply Docker update?'}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {
                            'The panel will save and stop Project Zomboid through RCON, then rebuild and recreate the all-in-one container. Players will be disconnected while the panel comes back online.'
                          }
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            setDockerUpdateConfirmOpen(false)
                            handleDownloadPanelUpdate()
                          }}
                        >
                          {'Stop server and update'}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <Button
                    onClick={handleDownloadPanelUpdate}
                    disabled={
                      !panelUpdateStatus?.updateAvailable ||
                      checkingPanelUpdate ||
                      downloadingPanelUpdate ||
                      restarting ||
                      panelUpdatePreflight?.ok === false
                    }
                    className="gap-2"
                  >
                    {downloadingPanelUpdate ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    {downloadingPanelUpdate
                      ? 'Downloading...'
                      : 'Download Update'}
                  </Button>
                )}

                {!isDockerPanelUpdate && (
                  <AlertDialog
                    open={applyConfirmOpen}
                    onOpenChange={(open) => {
                      setApplyConfirmOpen(open)
                      if (!open) setApplyRiskConfirmed(false)
                    }}
                  >
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="warning"
                        disabled={
                          !panelUpdateReady ||
                          restarting ||
                          isDirty ||
                          downloadingPanelUpdate ||
                          Boolean(panelUpdateStatus?.isDownloading) ||
                          panelUpdatePreflight?.ok === false
                        }
                        className="gap-2"
                      >
                        {restarting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RotateCw className="w-4 h-4" />
                        )}
                        {'Restart and Apply Update'}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {'Apply panel update?'}
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                          <div className="space-y-3 text-sm">
                            <p>
                              {
                                'The panel will exit immediately. A helper process will swap the executable and relaunch it in a few seconds.'
                              }
                              {panelUpdateStatus?.stagedUpdate?.version
                                ? ' You are about to install v' +
                                  String(
                                    panelUpdateStatus.stagedUpdate.version,
                                  ) +
                                  '.'
                                : ''}
                            </p>
                            <p
                              className={
                                updateRestartIsRisky
                                  ? 'font-medium text-destructive'
                                  : 'text-foreground'
                              }
                            >
                              {restartAssessmentMessage(
                                updateRestartAssessment,
                                'updates',
                              )}
                            </p>
                            {panelUpdatePreflight?.warnings.length ? (
                              <div>
                                <p className="font-medium text-foreground">
                                  {'Please confirm before continuing:'}
                                </p>
                                <ul className="mt-1 list-disc space-y-1 ps-5">
                                  {translatePanelUpdateMessages(
                                    panelUpdatePreflight.warnings,
                                    panelUpdatePreflight.warningDetails,
                                  ).map((w, i) => (
                                    <li
                                      key={`confirm-wrn-${i}`}
                                      className="break-words"
                                    >
                                      {w}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                            <p className="text-xs text-muted-foreground">
                              If the new version does not return online within a
                              minute, inspect{' '}
                              <code>
                                {panelUpdatePreflight?.info.applyLogPath ||
                                  runtimeInfo?.temporaryDirectory ||
                                  'the panel log directory'}
                              </code>
                              {runtimeInfo?.family === 'posix'
                                ? ' or journalctl -u zomboid-panel.'
                                : '.'}
                            </p>
                            {updateRestartIsRisky && (
                              <label className="flex items-start gap-2 text-sm text-foreground">
                                <Checkbox
                                  checked={applyRiskConfirmed}
                                  onCheckedChange={(checked) =>
                                    setApplyRiskConfirmed(checked === true)
                                  }
                                />
                                <span>
                                  {
                                    'I understand that running game servers may be stopped.'
                                  }
                                </span>
                              </label>
                            )}
                          </div>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
                        <AlertDialogAction
                          disabled={updateRestartIsRisky && !applyRiskConfirmed}
                          onClick={() =>
                            restartPanelWithReconnect(
                              'Applying downloaded update. Restarting panel...',
                            )
                          }
                        >
                          {'Restart and apply'}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}

                {panelUpdateStatus?.releaseUrl && (
                  <Button asChild variant="ghost" className="gap-2">
                    <a
                      href={panelUpdateStatus.releaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="max-w-full truncate"
                      title={panelUpdateStatus.releaseUrl}
                    >
                      <ExternalLink className="h-4 w-4" />
                      {'View Release Notes'}{' '}
                      <span className="sr-only">{'(opens in new tab)'}</span>
                    </a>
                  </Button>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {isDirty
                  ? 'Save settings before applying an update.'
                  : panelUpdateReady
                    ? 'Update files are ready. Restart to switch to the new version.'
                    : panelUpdateStatus?.updateAvailable
                      ? isDockerPanelUpdate
                        ? 'Applying this update saves and stops Project Zomboid, then rebuilds and recreates the all-in-one container.'
                        : 'Download the update, then restart to apply it.'
                      : 'No update is ready to install.'}
              </p>

              <p className="text-xs text-muted-foreground">
                {isDockerPanelUpdate
                  ? 'Docker updates are handled by the configured host controller.'
                  : 'Auto-update only works in packaged builds. In a dev checkout, update with git. Running in Docker without the update controller configured? Update with docker compose pull && docker compose up -d.'}
              </p>
            </div>
          </TabsContent>

          <TabsContent value="https" className="mt-0">
            <Card id="settings-https">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-primary" />
                  {'HTTPS'}
                </CardTitle>
                <CardDescription>
                  {'Encrypt panel traffic with a TLS certificate.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Alert className="border-border/60 bg-muted/40">
                  <Lock className="h-4 w-4 text-primary" />
                  <AlertTitle>{'Recommended Setup (Most Servers)'}</AlertTitle>
                  <AlertDescription className="space-y-2 text-sm text-muted-foreground">
                    <p>
                      {
                        'Enable HTTPS, leave certificate paths empty, save, then restart.'
                      }
                    </p>
                    <p>
                      {
                        'The panel creates a local self-signed certificate automatically.'
                      }
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={applyRecommendedHttpsDefaults}
                      >
                        {'Use Recommended Defaults'}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>

                <div className="flex items-center gap-3 p-4 rounded-xl bg-muted/50">
                  <Switch
                    checked={settings.httpsEnabled}
                    onCheckedChange={(value) =>
                      updateSetting('httpsEnabled', value)
                    }
                    aria-label={'Enable HTTPS'}
                  />
                  <div>
                    <Label className="text-base">{'Enable HTTPS'}</Label>
                    <p className="text-sm text-muted-foreground">
                      {'Serve the panel over HTTPS.'}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-border/60 bg-background/50 p-3 text-xs text-muted-foreground space-y-1">
                  <p>
                    <strong className="text-foreground">{'HTTP URL:'}</strong>{' '}
                    <code className="break-all">{httpPreviewUrl}</code>
                  </p>
                  <p>
                    <strong className="text-foreground">{'HTTPS URL:'}</strong>{' '}
                    <code className="break-all">{httpsPreviewUrl}</code>
                  </p>
                </div>

                {settings.httpsEnabled && (
                  <div className="ms-2 space-y-4 border-s-2 border-primary/20 ps-2">
                    <div className="max-w-xs">
                      <Label htmlFor="https-port">{'HTTPS Port'}</Label>
                      <Input
                        id="https-port"
                        type="number"
                        value={settings.httpsPort}
                        onChange={(e) =>
                          updateSetting('httpsPort', e.target.value)
                        }
                        onWheel={(e) => e.currentTarget.blur()}
                        min="1024"
                        max="65535"
                        placeholder="3443"
                        inputMode="numeric"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {'HTTPS listener port (recommended 3443).'}
                      </p>
                    </div>
                    <div className="max-w-md">
                      <Label htmlFor="https-cert-path">
                        {'Custom Certificate Path'}{' '}
                        <span className="text-muted-foreground font-normal">
                          {'(optional)'}
                        </span>
                      </Label>
                      <Input
                        id="https-cert-path"
                        value={settings.httpsCertPath}
                        onChange={(e) =>
                          updateSetting('httpsCertPath', e.target.value)
                        }
                        placeholder={
                          runtimeInfo?.family === 'windows'
                            ? 'Example: C:\\certs\\panel.fullchain.pem'
                            : runtimeInfo?.family === 'posix'
                              ? 'Example: /etc/zomboid-panel/panel.fullchain.pem'
                              : 'Path to the certificate PEM file'
                        }
                        maxLength={260}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {
                          'Set both certificate and key paths, or leave both empty.'
                        }
                      </p>
                    </div>
                    <div className="max-w-md">
                      <Label htmlFor="https-key-path">
                        {'Custom Key Path'}{' '}
                        <span className="text-muted-foreground font-normal">
                          {'(optional)'}
                        </span>
                      </Label>
                      <Input
                        id="https-key-path"
                        value={settings.httpsKeyPath}
                        onChange={(e) =>
                          updateSetting('httpsKeyPath', e.target.value)
                        }
                        placeholder={
                          runtimeInfo?.family === 'windows'
                            ? 'Example: C:\\certs\\panel.privkey.pem'
                            : runtimeInfo?.family === 'posix'
                              ? 'Example: /etc/zomboid-panel/panel.privkey.pem'
                              : 'Path to the private key PEM file'
                        }
                        maxLength={260}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {'Supports PEM key files that Node.js can read.'}
                      </p>
                    </div>

                    {hasPartialHttpsCertPath && (
                      <Alert className="border-warning/40 bg-warning/10">
                        <AlertTriangle className="h-4 w-4 text-warning" />
                        <AlertTitle className="text-warning">
                          {'Provide Both Certificate Files'}
                        </AlertTitle>
                        <AlertDescription>
                          {
                            'Set both certificate and key paths, or clear both to use auto-generated certs.'
                          }
                        </AlertDescription>
                      </Alert>
                    )}

                    {usingAutoGeneratedHttpsCert && (
                      <Alert className="border-primary/30 bg-primary/10">
                        <Lock className="h-4 w-4 text-primary" />
                        <AlertTitle className="text-primary">
                          {'Auto-Generated Certificate Mode'}
                        </AlertTitle>
                        <AlertDescription>
                          {
                            'The panel will create and reuse a local self-signed certificate.'
                          }
                        </AlertDescription>
                      </Alert>
                    )}

                    <Alert className="border-border/60 bg-muted/35">
                      <Lock className="h-4 w-4 text-muted-foreground" />
                      <AlertTitle>{'Reverse Proxy Note'}</AlertTitle>
                      <AlertDescription>
                        {
                          'If TLS is terminated by Nginx, Caddy, or Cloudflare Tunnel, keep panel HTTPS off and proxy local HTTP.'
                        }
                      </AlertDescription>
                    </Alert>

                    {originalSettings &&
                      settings.httpsEnabled !==
                        originalSettings.httpsEnabled && (
                        <Alert className="border-warning/40 bg-warning/10">
                          <AlertTriangle className="h-4 w-4 text-warning" />
                          <AlertTitle className="text-warning">
                            {'Restart Required'}
                          </AlertTitle>
                          <AlertDescription>
                            {
                              'HTTPS changes require restart. Save first, then restart from Panel Settings.'
                            }
                          </AlertDescription>
                        </Alert>
                      )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="connection" className="mt-0 space-y-5">
            <Card id="settings-rcon">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Link className="w-4 h-4 text-primary" />
                  {'RCON Connection'}
                </CardTitle>
                <CardDescription>
                  {
                    'Test the connection and set reconnect behavior. Host, port, and password are configured per-server on the Servers page.'
                  }
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  <Button
                    variant="outline"
                    onClick={handleTestRcon}
                    disabled={testingRcon}
                    className="w-full sm:w-auto"
                  >
                    {testingRcon ? (
                      <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    ) : null}
                    {'Test Connection'}
                  </Button>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={settings.autoReconnect}
                      onCheckedChange={(value) =>
                        updateSetting('autoReconnect', value)
                      }
                      aria-label={'Auto-reconnect RCON on disconnect'}
                    />
                    <Label>{'Auto-reconnect on disconnect'}</Label>
                  </div>
                </div>
                {settings.autoReconnect && (
                  <div className="max-w-xs">
                    <Label htmlFor="reconnect-interval">
                      {'Reconnect Interval (seconds)'}
                    </Label>
                    <Input
                      id="reconnect-interval"
                      type="number"
                      value={settings.reconnectInterval}
                      onChange={(e) =>
                        updateSetting('reconnectInterval', e.target.value)
                      }
                      onWheel={(e) => e.currentTarget.blur()}
                      min="1"
                      max="60"
                      inputMode="numeric"
                    />
                  </div>
                )}
                <div className="p-4 bg-muted rounded-xl text-sm">
                  <p className="font-medium mb-2">
                    {'RCON is configured per-server:'}
                  </p>
                  <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                    <li>
                      <>
                        {'Go to '}
                        <strong>{'Servers'}</strong>
                        {' page'}
                      </>
                    </li>
                    <li>
                      <>
                        {'Click '}
                        <strong>{'Edit'}</strong>
                        {' on your server'}
                      </>
                    </li>
                    <li>{'Configure RCON host, port, and password there'}</li>
                  </ol>
                </div>
              </CardContent>
            </Card>

            <Card id="settings-server-startup">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-primary" />
                  {'Server Startup'}
                </CardTitle>
                <CardDescription>
                  {'Whether the panel launches the game server for you.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 p-3">
                  <div className="space-y-1">
                    <Label
                      htmlFor="auto-start-server"
                      className="text-sm font-medium"
                    >
                      {'Start the game server when the panel starts'}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {
                        'Skipped automatically when the RCON port is already in use, so a server that is already running is never duplicated. Needs a local install path; servers hosted by a provider are started by the provider.'
                      }
                    </p>
                  </div>
                  <Switch
                    id="auto-start-server"
                    checked={settings.autoStartServer}
                    onCheckedChange={(value) =>
                      updateSetting('autoStartServer', value)
                    }
                    aria-label={'Start the game server when the panel starts'}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="bridge" className="mt-0">
            <Card id="settings-bridge">
              <CardHeader className="pb-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-primary" />
                      {'Panel Bridge'}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-2">
                      {
                        'Connects this panel to the live game for weather, utilities, richer chat, and other in-world actions'
                      }
                      <Dialog>
                        <DialogTrigger asChild>
                          <button className="inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap">
                            <Info className="w-3.5 h-3.5" />
                            {'How it works'}
                          </button>
                        </DialogTrigger>
                        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                          <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                              <Zap className="w-4 h-4 text-primary" />
                              {'Panel Bridge'}
                            </DialogTitle>
                            <DialogDescription>
                              {
                                'A Lua mod that runs inside Project Zomboid, giving this panel direct access to the live game world.'
                              }
                            </DialogDescription>
                          </DialogHeader>
                          <div className="space-y-5 text-sm">
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                                {'What it unlocks'}
                              </p>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                                  <p className="font-medium text-foreground">
                                    {'Weather & Climate'}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {'Storms, rain, temperature, fog, wind'}
                                  </p>
                                </div>
                                <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                                  <p className="font-medium text-foreground">
                                    {'Player Actions'}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {'Teleport, heal, god mode, inventory'}
                                  </p>
                                </div>
                                <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                                  <p className="font-medium text-foreground">
                                    {'World Control'}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {'Utilities, zombies, time, sandbox'}
                                  </p>
                                </div>
                                <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                                  <p className="font-medium text-foreground">
                                    {'Chat & Sound'}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {'Server chat, admin chat, world sounds'}
                                  </p>
                                </div>
                              </div>
                            </div>

                            <div>
                              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                                {'How it works'}
                              </p>
                              <p className="text-muted-foreground mb-3">
                                <>
                                  {
                                    'Two pieces meet in the middle: the panel runs a file watcher, and '
                                  }
                                  <strong className="text-foreground">
                                    {'PanelBridge.lua'}
                                  </strong>
                                  {
                                    ' runs inside the game. They exchange commands via JSON files.'
                                  }
                                </>
                              </p>
                            </div>

                            <div>
                              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                                {'Setup'}
                              </p>
                              <ol className="space-y-2">
                                <li className="flex gap-3 items-start">
                                  <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                                    1
                                  </span>
                                  <div>
                                    <p className="font-medium">
                                      {'Install the Lua file'}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                      {
                                        'Use the Install section on this tab to copy PanelBridge.lua into your server.'
                                      }
                                    </p>
                                  </div>
                                </li>
                                <li className="flex gap-3 items-start">
                                  <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                                    2
                                  </span>
                                  <div>
                                    <p className="font-medium">
                                      {'Run Auto Setup'}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                      {
                                        'Points the panel at the correct server data folder and starts the watcher.'
                                      }
                                    </p>
                                  </div>
                                </li>
                                <li className="flex gap-3 items-start">
                                  <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                                    3
                                  </span>
                                  <div>
                                    <p className="font-medium">
                                      {'Start the PZ server'}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                      <>
                                        {
                                          'When the game loads the mod, status changes from '
                                        }
                                        {'Waiting'}
                                        {' to '}
                                        {'Connected'}
                                        {'.'}
                                      </>
                                    </p>
                                  </div>
                                </li>
                              </ol>
                            </div>

                            <div className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs">
                              <p>
                                <>
                                  <strong>
                                    {'Requires DoLuaChecksum=false'}
                                  </strong>
                                  {
                                    ' in your server INI. Commands can fail with checksum enabled.'
                                  }
                                </>
                              </p>
                            </div>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </CardDescription>
                  </div>
                  {bridgeStatus && (
                    <BridgeStatusBadge
                      connected={
                        bridgeStatus.modConnected &&
                        bridgeStatus.connection?.canSendCommands === true
                      }
                      running={bridgeStatus.isRunning}
                      loading={bridgeLoading}
                      bridgePath={bridgeStatus.bridgePath}
                      summary={bridgeStatus.connection?.summary}
                      interactive={false}
                    />
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {bridgeStatus?.modConnected && bridgeStatus.modStatus && (
                  <Alert
                    className="border-primary/30 bg-primary/10"
                    aria-live="polite"
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <CheckCircle2 className="w-5 h-5 text-primary" />
                      <span className="font-semibold text-primary">
                        {'Connected to ' +
                          String(bridgeStatus.modStatus.serverName || 'server')}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">
                          {'Mod Version:'}
                        </span>{' '}
                        <span className="font-medium">
                          {bridgeStatus.modStatus.version || 'Unknown'}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          {'Players Online:'}
                        </span>{' '}
                        <span className="font-medium">
                          {bridgeStatus.modStatus.alive
                            ? (bridgeStatus.modStatus.playerCount ?? 0)
                            : 'Offline'}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      {
                        'Advanced features on Events, Players, and Chat are now available.'
                      }
                    </p>
                  </Alert>
                )}

                {!bridgeStatus?.isRunning && (
                  <div className="p-4 bg-muted rounded-xl space-y-3">
                    {isRemoteServer ? (
                      <>
                        <p className="text-sm font-medium">
                          {'Remote server setup'}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {
                            'This panel is running separately from your PZ server. Skip Auto Setup and the local bridge path above.'
                          }
                        </p>
                        <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
                          <li>
                            <>
                              {'Copy '}
                              <strong className="text-foreground">
                                {'PanelBridge.lua'}
                              </strong>
                              {" into the remote server's Lua folder."}
                            </>
                          </li>
                          <li>
                            <>
                              {'Set '}
                              <strong className="text-foreground">
                                {'DoLuaChecksum=false'}
                              </strong>
                              {' in the remote server INI.'}
                            </>
                          </li>
                          <li>
                            <>
                              {'Enter the VPS path in '}
                              <strong className="text-foreground">
                                {'SFTP PanelBridge files'}
                              </strong>
                              {' below.'}
                            </>
                          </li>
                          <li>
                            <>
                              {'Click '}
                              <strong className="text-foreground">
                                {'Verify and prepare SFTP'}
                              </strong>
                              {', then '}
                              <strong className="text-foreground">
                                {'Start SFTP bridge'}
                              </strong>
                              {'.'}
                            </>
                          </li>
                          <li>{'Start or restart the PZ server.'}</li>
                        </ol>
                        <p className="text-xs text-muted-foreground">
                          {
                            'The SFTP bridge creates the remote bridge, inbox, and outbox folders automatically. The path must be on the VPS, not on this computer.'
                          }
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium">{'Get Started'}</p>
                        <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
                          <li>
                            <>
                              {'Install '}
                              <strong className="text-foreground">
                                {'PanelBridge.lua'}
                              </strong>
                              {' using the section below'}
                            </>
                          </li>
                          <li>
                            <>
                              {'Set '}
                              <strong className="text-foreground">
                                {'DoLuaChecksum=false'}
                              </strong>
                              {' in your server INI'}
                            </>
                          </li>
                          <li>
                            <>
                              {'Click '}
                              <strong className="text-foreground">
                                {'Auto Setup'}
                              </strong>
                              {' to start the bridge watcher'}
                            </>
                          </li>
                          <li>{'Start or restart the PZ server'}</li>
                        </ol>
                        <Button
                          onClick={() => handleAutoConfigure()}
                          disabled={bridgeLoading}
                          className="gap-2"
                        >
                          {bridgeLoading ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Zap className="w-4 h-4" />
                          )}
                          {'Auto Setup'}
                        </Button>

                        <div className="border-t border-border/50 pt-3 mt-1 space-y-2">
                          <p className="text-xs text-muted-foreground">
                            {
                              'Or set the bridge path manually (Linux / VPS / custom installs):'
                            }
                          </p>
                          <div className="flex gap-2">
                            <Input
                              value={manualBridgePath}
                              onChange={(e) =>
                                setManualBridgePath(e.target.value)
                              }
                              placeholder="/home/pzuser/Zomboid/Lua/panelbridge/MyServer"
                              className="text-xs h-9"
                            />
                            <Button
                              onClick={handleManualConfigure}
                              disabled={
                                bridgeLoading || !manualBridgePath.trim()
                              }
                              variant="secondary"
                              size="sm"
                              className="shrink-0 gap-1.5"
                            >
                              {bridgeLoading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <FolderOpen className="w-3.5 h-3.5" />
                              )}
                              {'Connect'}
                            </Button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {bridgeStatus?.isRunning && !bridgeStatus?.modConnected && (
                  <Alert
                    className="border-warning/40 bg-warning/10"
                    aria-live="polite"
                  >
                    <Cloud className="h-4 w-4 text-warning" />
                    <AlertTitle className="text-warning">
                      {'Waiting for PZ mod'}
                    </AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>
                        {isRemoteServer &&
                        bridgeStatus.transport?.type === 'sftp'
                          ? 'SFTP is ready, but the panel has not received a status file from the remote PZ server yet.'
                          : 'The panel is ready. Start the PZ server with PanelBridge.lua installed and DoLuaChecksum=false set.'}
                      </p>
                      {isRemoteServer &&
                      bridgeStatus.transport?.type === 'sftp' ? (
                        <>
                          <p className="text-xs text-muted-foreground break-words">
                            {'Remote folder:'}{' '}
                            <code className="rounded bg-background px-1 break-all">
                              {settings.panelBridgeSftpBridgePath}
                            </code>
                          </p>
                          {bridgeStatus?.bridgePath && (
                            <p className="text-xs text-muted-foreground break-words">
                              {'Local SFTP cache:'}{' '}
                              <code className="rounded bg-background px-1 break-all">
                                {bridgeStatus.bridgePath}
                              </code>
                            </p>
                          )}
                        </>
                      ) : bridgeStatus?.bridgePath ? (
                        <p className="text-xs text-muted-foreground break-words">
                          {'Watching:'}{' '}
                          <code className="rounded bg-background px-1 break-all">
                            {bridgeStatus.bridgePath}
                          </code>
                        </p>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                )}

                {bridgeStatus?.isRunning &&
                  !bridgeStatus?.modConnected &&
                  bridgeStatus?.connection && (
                    <div className="rounded-lg border border-border/60 bg-muted/30 overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border/40">
                        <Info className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-xs font-medium text-foreground">
                          {'Connection Diagnostics'}
                        </span>
                        {bridgeStatus.consecutiveFailures != null &&
                          bridgeStatus.consecutiveFailures > 0 && (
                            <span className="ms-auto text-[10px] tabular-nums text-warning">
                              {String(bridgeStatus.consecutiveFailures) +
                                ' consecutive failures'}
                            </span>
                          )}
                      </div>
                      <div className="p-3 space-y-3">
                        <p className="text-xs text-muted-foreground">
                          {bridgeStatus.connection.summary}
                        </p>

                        {bridgeStatus.connection.issues &&
                          bridgeStatus.connection.issues.length > 0 && (
                            <div className="space-y-1">
                              {bridgeStatus.connection.issues.map(
                                (issue: string, i: number) => (
                                  <div
                                    key={i}
                                    className="flex items-start gap-1.5 text-xs text-destructive"
                                  >
                                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                    <span>{issue}</span>
                                  </div>
                                ),
                              )}
                            </div>
                          )}

                        {bridgeStatus.connection.checks && (
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                            {Object.entries(bridgeStatus.connection.checks).map(
                              ([key, val]) => {
                                if (key === 'statusAgeMs') return null
                                const label = key
                                  .replace(/([A-Z])/g, ' $1')
                                  .replace(/^./, (s) => s.toUpperCase())
                                  .trim()
                                const passed = val === true
                                return (
                                  <div
                                    key={key}
                                    className="flex items-center gap-1.5"
                                  >
                                    {passed ? (
                                      <CheckCircle2
                                        className="w-3 h-3 text-primary shrink-0"
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <XCircle
                                        className="w-3 h-3 text-destructive shrink-0"
                                        aria-hidden="true"
                                      />
                                    )}
                                    <span
                                      className={cn(
                                        passed
                                          ? 'text-muted-foreground'
                                          : 'text-destructive/90',
                                      )}
                                    >
                                      {label}
                                    </span>
                                  </div>
                                )
                              },
                            )}
                          </div>
                        )}

                        {bridgeStatus.statusFile && (
                          <div className="text-[11px] text-muted-foreground space-y-0.5 pt-1 border-t border-border/30">
                            <div className="flex items-center gap-1.5">
                              <span className="opacity-60">
                                {'Status file:'}
                              </span>
                              <span
                                className={
                                  bridgeStatus.statusFile.exists
                                    ? 'text-foreground'
                                    : 'text-destructive/70'
                                }
                              >
                                {bridgeStatus.statusFile.exists
                                  ? 'Present'
                                  : 'Not found'}
                              </span>
                              {bridgeStatus.statusFile.ageSeconds != null && (
                                <span className="opacity-50">
                                  {'(' +
                                    String(
                                      formatBridgeAge(
                                        bridgeStatus.statusFile.ageSeconds,
                                      ),
                                    ) +
                                    ' ago)'}
                                </span>
                              )}
                            </div>
                            {bridgeStatus.statusFile.path && (
                              <div className="break-all opacity-50">
                                <code className="text-[10px]">
                                  {bridgeStatus.statusFile.path}
                                </code>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground pt-1 border-t border-border/30">
                          <span>
                            {'File watcher:'}{' '}
                            {bridgeStatus.hasFileWatcher ? (
                              <span className="text-primary">{'Active'}</span>
                            ) : (
                              <span className="text-warning">
                                {'Polling only'}
                              </span>
                            )}
                          </span>
                          {bridgeStatus.pendingCommands > 0 && (
                            <span>
                              {'Pending:'}{' '}
                              <span className="text-warning tabular-nums">
                                {bridgeStatus.pendingCommands}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                {bridgeError && (
                  <Alert variant="destructive" aria-live="assertive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>{'Panel Bridge Error'}</AlertTitle>
                    <AlertDescription>{bridgeError}</AlertDescription>
                  </Alert>
                )}

                {bridgeStatus?.isRunning && (
                  <div className="flex flex-wrap gap-3">
                    <Button
                      onClick={handleStopBridge}
                      disabled={bridgeLoading}
                      variant="outline"
                      size="sm"
                      className="gap-2"
                    >
                      {bridgeLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <XCircle className="w-4 h-4" />
                      )}
                      {'Stop Bridge'}
                    </Button>
                    <Button
                      onClick={handlePingMod}
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={
                        !bridgeStatus?.modConnected ||
                        bridgeStatus?.connection?.canSendCommands !== true ||
                        pinging
                      }
                    >
                      {pinging ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      {pinging ? 'Pinging...' : 'Ping Mod'}
                    </Button>
                    <Button
                      onClick={fetchBridgeStatus}
                      variant="ghost"
                      size="sm"
                      className="gap-2"
                    >
                      <RefreshCw className="w-4 h-4" />
                      {'Refresh Status'}
                    </Button>
                  </div>
                )}

                <div className="border-t border-border/60 pt-5 space-y-4">
                  <div>
                    <p className="text-sm font-medium">{'Remote connection'}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {
                        'PanelBridge and RCON are separate transports. Configure both for a remote server so every Events, Players, and bridge action has the path it needs.'
                      }
                    </p>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
                    <div
                      id="rcon-command-connection"
                      className="rounded-md border border-border/60 p-4 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">
                            {'RCON command connection'}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {
                              'Used for console commands and RCON-backed event actions. It is stored with the active server profile, not with PanelBridge.'
                            }
                          </p>
                        </div>
                        <Link className="h-4 w-4 shrink-0 text-primary" />
                      </div>
                      {activeServer ? (
                        <div className="rounded border border-border/50 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                          <p className="font-medium text-foreground">
                            {activeServer.name}
                          </p>
                          <p className="mt-1 font-mono">
                            {activeServer.rconHost || 'Host not configured'}:
                            {activeServer.rconPort || 'port not configured'}
                          </p>
                        </div>
                      ) : (
                        <p className="text-xs text-warning">
                          {'No active server profile is available.'}
                        </p>
                      )}
                      <RouterLink
                        to="/servers"
                        className="inline-flex text-xs font-medium text-primary hover:underline underline-offset-2"
                      >
                        {'Edit active server RCON connection'}
                      </RouterLink>
                    </div>

                    <div
                      id="sftp-panelbridge"
                      className="rounded-md border border-border/60 p-4 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">
                            {'SFTP PanelBridge files'}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {isRemoteServer
                              ? 'For this remote server, enter the VPS folder here. The panel syncs only bridge status, commands, and results.'
                              : 'Syncs only the bridge status, command queue, and results folder. It does not read general server files.'}
                          </p>
                        </div>
                        <Cloud className="h-4 w-4 shrink-0 text-primary" />
                      </div>
                      <div className="rounded border border-border/50 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                        <strong className="text-foreground">
                          {'Setup order:'}
                        </strong>{' '}
                        <>
                          {'enter the VPS folder, click '}
                          <strong className="text-foreground">
                            {'Verify and prepare SFTP'}
                          </strong>
                          {
                            ' to verify access and create the bridge queue folders, then click '
                          }
                          <strong className="text-foreground">
                            {'Start SFTP bridge'}
                          </strong>
                          {
                            '. A missing status file means the PZ server has not written one yet.'
                          }
                        </>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="sftp-host">{'SFTP host'}</Label>
                            <HelpTip label={'SFTP host'}>
                              {
                                "Only needed when the dedicated server runs on a different machine than this panel. The panel connects here over SFTP to read and write that machine's config files. Get these details from whoever manages that machine — if your server runs on this same computer, leave this whole section blank."
                              }
                            </HelpTip>
                          </div>
                          <Input
                            id="sftp-host"
                            value={settings.panelBridgeSftpHost}
                            onChange={(event) =>
                              updateSetting(
                                'panelBridgeSftpHost',
                                event.target.value,
                              )
                            }
                            placeholder="pz.example.net"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="sftp-port">{'Port'}</Label>
                          <Input
                            id="sftp-port"
                            inputMode="numeric"
                            value={settings.panelBridgeSftpPort}
                            onChange={(event) =>
                              updateSetting(
                                'panelBridgeSftpPort',
                                event.target.value,
                              )
                            }
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="sftp-user">{'Username'}</Label>
                          <Input
                            id="sftp-user"
                            autoComplete="username"
                            value={settings.panelBridgeSftpUsername}
                            onChange={(event) =>
                              updateSetting(
                                'panelBridgeSftpUsername',
                                event.target.value,
                              )
                            }
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="sftp-password">{'Password'}</Label>
                          <PasswordInput
                            id="sftp-password"
                            autoComplete="current-password"
                            value={settings.panelBridgeSftpPassword}
                            onChange={(value) =>
                              updateSetting('panelBridgeSftpPassword', value)
                            }
                            placeholder={'Stored securely'}
                            label={'SFTP password'}
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="sftp-bridge-path">
                          {'Remote bridge folder on the VPS'}
                        </Label>
                        <Input
                          id="sftp-bridge-path"
                          value={settings.panelBridgeSftpBridgePath}
                          onChange={(event) =>
                            updateSetting(
                              'panelBridgeSftpBridgePath',
                              event.target.value,
                            )
                          }
                          placeholder="/home/pzuser/Zomboid/Lua/panelbridge/MyServer"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {
                            'Use the path as seen by this SFTP account. Do not enter a Windows path or a path from your local computer.'
                          }
                        </p>
                      </div>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="w-36 space-y-1.5">
                          <Label htmlFor="sftp-poll">
                            {'Sync interval (seconds)'}
                          </Label>
                          <Input
                            id="sftp-poll"
                            inputMode="numeric"
                            value={settings.panelBridgeSftpPollIntervalSeconds}
                            onChange={(event) =>
                              updateSetting(
                                'panelBridgeSftpPollIntervalSeconds',
                                event.target.value,
                              )
                            }
                          />
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleTestSftp}
                          disabled={testingSftp || bridgeLoading}
                        >
                          {testingSftp ? (
                            <Loader2 className="me-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Link className="me-2 h-4 w-4" />
                          )}
                          {'Verify and prepare SFTP'}
                        </Button>
                        <Button
                          type="button"
                          onClick={handleConfigureSftp}
                          disabled={bridgeLoading}
                        >
                          {bridgeLoading ? (
                            <Loader2 className="me-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Cloud className="me-2 h-4 w-4" />
                          )}
                          {'Start SFTP bridge'}
                        </Button>
                      </div>
                      {bridgeStatus?.transport?.type === 'sftp' && (
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <p>
                            SFTP{' '}
                            {bridgeStatus.transport.running
                              ? 'running'
                              : 'stopped'}
                            {bridgeStatus.transport.lastLatencyMs != null
                              ? ', last sync ' +
                                String(bridgeStatus.transport.lastLatencyMs) +
                                ' ms'
                              : ''}
                          </p>
                          {bridgeStatus.transport.lastError && (
                            <p className="text-warning">
                              {getSftpStatusMessage(bridgeStatus.transport)}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    <>
                      <strong className="text-foreground">
                        {'Server logs:'}
                      </strong>
                      {
                        ' read-only. The panel lists the remote log folder and fetches the tail of a file on demand. Nothing is written to the remote host and whole files are never mirrored to disk.'
                      }
                    </>
                  </p>

                  <div className="rounded-md border border-border/60 p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">
                          {'Remote server config'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          <>
                            {'Absolute path to the '}
                            <code>{'Server'}</code>
                            {
                              ' folder on the remote host. Setting this unlocks the Server Config page for a remote server: the panel mirrors '
                            }
                            <code>{'.ini'}</code>
                            {' and '}
                            <code>{'SandboxVars.lua'}</code>
                            {' over SFTP, edits the copy, then writes it back.'}
                          </>
                        </p>
                      </div>
                      <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                      <div className="min-w-0 flex-1 space-y-1.5 sm:min-w-[18rem]">
                        <Label htmlFor="sftp-config-path">
                          {'Remote Server folder'}
                        </Label>
                        <Input
                          id="sftp-config-path"
                          value={settings.panelBridgeSftpConfigPath}
                          onChange={(event) =>
                            updateSetting(
                              'panelBridgeSftpConfigPath',
                              event.target.value,
                            )
                          }
                          placeholder="/home/pz/Zomboid/Server"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleCheckRemoteConfig}
                        disabled={
                          loadingRemoteConfig ||
                          !settings.panelBridgeSftpConfigPath.trim()
                        }
                      >
                        {loadingRemoteConfig ? (
                          <Loader2 className="me-2 h-4 w-4 animate-spin" />
                        ) : (
                          <FolderOpen className="me-2 h-4 w-4" />
                        )}
                        {'Check folder'}
                      </Button>
                    </div>

                    {remoteConfigError && (
                      <p className="text-xs text-destructive">
                        {remoteConfigError}
                      </p>
                    )}

                    {remoteConfigFiles.length > 0 && (
                      <ul className="max-h-40 divide-y divide-border/40 overflow-auto rounded border border-border/50">
                        {remoteConfigFiles.map((file) => (
                          <li
                            key={file.name}
                            className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
                          >
                            <span className="font-mono">{file.name}</span>
                            <span className="tabular-nums text-muted-foreground">
                              {file.size} B
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="rounded-md border border-border/60 p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">
                          {'Remote server logs'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          <>
                            {'Absolute path to the Zomboid '}
                            <code>{'Logs'}</code>
                            {' folder on the remote host. Only '}
                            <code>{'.txt'}</code>
                            {' and '}
                            <code>{'.log'}</code>
                            {' files are listed.'}
                          </>
                        </p>
                      </div>
                      <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                      <div className="min-w-0 flex-1 space-y-1.5 sm:min-w-[18rem]">
                        <Label htmlFor="sftp-log-path">
                          {'Remote log folder'}
                        </Label>
                        <Input
                          id="sftp-log-path"
                          value={settings.panelBridgeSftpLogPath}
                          onChange={(event) =>
                            updateSetting(
                              'panelBridgeSftpLogPath',
                              event.target.value,
                            )
                          }
                          placeholder="/home/pz/Zomboid/Logs"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleListRemoteLogs}
                        disabled={
                          loadingRemoteLogs ||
                          !settings.panelBridgeSftpLogPath.trim()
                        }
                      >
                        {loadingRemoteLogs ? (
                          <Loader2 className="me-2 h-4 w-4 animate-spin" />
                        ) : (
                          <FolderOpen className="me-2 h-4 w-4" />
                        )}
                        {'List logs'}
                      </Button>
                    </div>

                    {remoteLogError && (
                      <p className="text-xs text-destructive">
                        {remoteLogError}
                      </p>
                    )}

                    {remoteLogs.length > 0 && (
                      <div className="space-y-2">
                        <div className="max-h-48 overflow-auto rounded border border-border/50">
                          <ul className="divide-y divide-border/40">
                            {remoteLogs.map((file) => (
                              <li
                                key={file.name}
                                className="flex items-center justify-between gap-3 px-3 py-2"
                              >
                                <button
                                  type="button"
                                  onClick={() => handleTailRemoteLog(file.name)}
                                  className="min-w-0 flex-1 truncate text-start text-xs font-mono text-primary hover:underline"
                                >
                                  {file.name}
                                </button>
                                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                  {(file.size / 1024).toFixed(0)} KB
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {'Select a file to load the last 256 KB.'}
                        </p>
                      </div>
                    )}

                    {remoteLogContent && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium">
                            {remoteLogContent.name}
                          </p>
                          <span className="text-[11px] text-muted-foreground">
                            {remoteLogContent.truncated ? 'tail of ' : ''}
                            {(remoteLogContent.bytesReturned / 1024).toFixed(
                              0,
                            )}{' '}
                            KB
                          </span>
                        </div>
                        <pre className="max-h-72 overflow-auto rounded border border-border/50 bg-background/60 p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words">
                          {remoteLogContent.content}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/25 p-4">
                  <div>
                    <Label className="text-sm font-medium">
                      {'Auto-update mod on panel startup'}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {
                        'When the panel starts, automatically copy the latest bundled PanelBridge.lua to the PZ server if versions differ.'
                      }
                    </p>
                  </div>
                  <Switch
                    checked={settings.panelBridgeAutoUpdate}
                    onCheckedChange={(value) =>
                      updateSetting('panelBridgeAutoUpdate', value)
                    }
                    aria-label={'Auto-update PanelBridge mod'}
                  />
                </div>

                <div className="p-4 bg-muted rounded-xl space-y-3">
                  <p className="text-sm font-medium">
                    {'Install PanelBridge.lua'}
                  </p>
                  <div className="flex flex-wrap gap-3 items-center">
                    <Select
                      value={selectedInstallServerId}
                      onValueChange={setSelectedInstallServerId}
                    >
                      <SelectTrigger className="w-[200px]">
                        <SelectValue placeholder={'Select server...'} />
                      </SelectTrigger>
                      <SelectContent>
                        {servers.length === 0 ? (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">
                            {serversLoadError
                              ? "Couldn't load the server list — try reopening this page"
                              : 'No servers configured'}
                          </div>
                        ) : (
                          servers.map((server) => (
                            <SelectItem
                              key={String(server.id)}
                              value={String(server.id)}
                            >
                              {server.name} {server.isActive ? '(Active)' : ''}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      onClick={handleInstallMod}
                      disabled={
                        installingMod ||
                        !selectedInstallServerId ||
                        selectedInstallServer?.isRemote
                      }
                      className="gap-2"
                      variant="outline"
                    >
                      {installingMod ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                      {'Install Mod'}
                    </Button>
                  </div>
                  {selectedInstallServer?.isRemote && (
                    <p className="text-xs text-warning">
                      {
                        'Remote server: copy PanelBridge.lua to the remote Lua folder with SFTP or the provider file manager. Automatic local installation is unavailable.'
                      }
                    </p>
                  )}
                  {selectedInstallTarget && (
                    <p className="text-xs text-muted-foreground break-all">
                      {'Destination:'}{' '}
                      <code className="bg-background px-1 rounded">
                        {selectedInstallTarget}
                      </code>
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="mods" className="mt-0 space-y-5">
            <Card id="settings-mods">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary" />
                    {'Mod Update Settings'}
                  </CardTitle>
                </div>
                <CardDescription>
                  {
                    'How often to check for Workshop updates and whether to auto-restart when updates arrive.'
                  }
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="max-w-xs space-y-2">
                  <Label htmlFor="mod-check-interval" className="text-base">
                    {'Check Interval (minutes)'}
                  </Label>
                  <Input
                    id="mod-check-interval"
                    type="number"
                    value={settings.modCheckInterval}
                    onChange={(e) =>
                      updateSetting('modCheckInterval', e.target.value)
                    }
                    onWheel={(e) => e.currentTarget.blur()}
                    min="1"
                    max="120"
                    step="1"
                    className="h-11"
                    inputMode="numeric"
                  />
                  <p className="text-sm text-muted-foreground">
                    {
                      'Check every 1-120 minutes. Changes take effect as soon as you save.'
                    }
                  </p>
                </div>
                <div className="flex items-center gap-3 p-4 rounded-xl bg-muted/50">
                  <Switch
                    checked={settings.modAutoRestart}
                    onCheckedChange={(value) =>
                      updateSetting('modAutoRestart', value)
                    }
                    aria-label={'Auto-restart server when mods update'}
                  />
                  <div>
                    <Label className="text-base">
                      {'Auto-restart server when mods update'}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {
                        'Automatically restart the server when mod updates are detected'
                      }
                    </p>
                  </div>
                </div>
                {settings.modAutoRestart && (
                  <div className="max-w-xs space-y-2 ps-4 border-s-2 border-primary/30">
                    <Label htmlFor="mod-restart-delay" className="text-base">
                      {'Restart Delay (minutes)'}
                    </Label>
                    <Input
                      id="mod-restart-delay"
                      type="number"
                      value={settings.modRestartDelay}
                      onChange={(e) =>
                        updateSetting('modRestartDelay', e.target.value)
                      }
                      onWheel={(e) => e.currentTarget.blur()}
                      min="1"
                      max="30"
                      className="h-11"
                      inputMode="numeric"
                    />
                    <p className="text-sm text-muted-foreground">
                      {'Players are warned before the restart happens.'}
                    </p>
                  </div>
                )}
                <div className="border-t border-border/60 pt-6">
                  <div className="flex items-center gap-3 p-4 rounded-xl bg-muted/50">
                    <Switch
                      checked={settings.serverAutoUpdate}
                      onCheckedChange={(value) =>
                        updateSetting('serverAutoUpdate', value)
                      }
                      aria-label={
                        'Automatically update the server when a new build is detected'
                      }
                    />
                    <div>
                      <Label className="text-base">
                        {'Automatically update the game server'}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {
                          'Save, stop, update through SteamCMD, then start again when a new build is detected.'
                        }
                      </p>
                    </div>
                  </div>
                  <div className="max-w-md space-y-2 ps-4 pt-4 border-s-2 border-primary/30">
                    <Label htmlFor="steam-update-account" className="text-base">
                      {'SteamCMD update account'}
                    </Label>
                    <Input
                      id="steam-update-account"
                      value={settings.steamUpdateAccount}
                      onChange={(e) =>
                        updateSetting('steamUpdateAccount', e.target.value)
                      }
                      placeholder={'Leave blank to use anonymous login'}
                      autoComplete="username"
                      className="h-11"
                    />
                    <p className="text-sm text-muted-foreground">
                      {
                        'Use a Steam account that owns Project Zomboid when anonymous updates cannot access a depot. Only the account name is saved; SteamCMD keeps its own encrypted login session and may ask for Steam Guard again.'
                      }
                    </p>
                  </div>
                  {settings.serverAutoUpdate && (
                    <div className="max-w-md space-y-2 ps-4 pt-4 border-s-2 border-primary/30">
                      <Label
                        htmlFor="server-update-warning-minutes"
                        className="text-base"
                      >
                        {'Player warning (minutes)'}
                      </Label>
                      <Input
                        id="server-update-warning-minutes"
                        type="number"
                        value={settings.serverAutoUpdateWarningMinutes}
                        onChange={(e) =>
                          updateSetting(
                            'serverAutoUpdateWarningMinutes',
                            e.target.value,
                          )
                        }
                        onWheel={(e) => e.currentTarget.blur()}
                        min="0"
                        max="60"
                        className="h-11"
                        inputMode="numeric"
                      />
                      <p className="text-sm text-muted-foreground">
                        {
                          'Defaults to 15 minutes. Set 0 to update immediately when no players are online.'
                        }
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <WorkshopCollectionSyncCard
              settings={settings}
              updateSetting={updateSetting}
              persistCookies={async (cookies) => {
                await configApi.updateAppSettings(cookies)
                setSettings((current) => ({ ...current, ...cookies }))
                setOriginalSettings((current) =>
                  current ? { ...current, ...cookies } : current,
                )
              }}
            />

            <Card id="settings-api-keys">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Key className="w-4 h-4 text-primary" />
                  {'API Keys'}
                </CardTitle>
                <CardDescription>
                  {
                    'Keys used for Steam Workshop lookups and the server finder.'
                  }
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Label htmlFor="steam-api-key" className="text-base">
                      {'Steam Web API Key'}
                    </Label>
                    {settings.steamApiKey &&
                    settings.steamApiKey.startsWith('•') ? (
                      <span className="inline-flex items-center gap-1 rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">
                        <Check className="w-3 h-3" aria-hidden="true" />{' '}
                        {'Configured'}
                      </span>
                    ) : settings.steamApiKey ? (
                      <span className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                        <AlertTriangle className="w-3 h-3" aria-hidden="true" />{' '}
                        {'Pending save'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded border border-muted-foreground/30 bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {'Not configured'}
                      </span>
                    )}
                  </div>
                  <div className="relative max-w-md">
                    <Input
                      id="steam-api-key"
                      type={showSteamApiKey ? 'text' : 'password'}
                      value={settings.steamApiKey}
                      onChange={(e) =>
                        updateSetting('steamApiKey', e.target.value)
                      }
                      placeholder={'Your Steam API key'}
                      className="h-11 pe-10"
                      maxLength={128}
                    />
                    <button
                      type="button"
                      onClick={() => setShowSteamApiKey(!showSteamApiKey)}
                      className="absolute right-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                      aria-label={
                        showSteamApiKey ? 'Hide API key' : 'Show API key'
                      }
                    >
                      {showSteamApiKey ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {
                      'Used for Steam Workshop mod information and server finder features.'
                    }
                  </p>
                  <div className="p-4 bg-muted rounded-xl text-sm mt-3">
                    <p className="font-medium mb-2">
                      {'How to get a Steam API Key:'}
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                      <li>
                        {'Go to'}{' '}
                        <a
                          href="https://steamcommunity.com/dev/apikey"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          {'Steam API Key Registration'}{' '}
                          <span className="sr-only">
                            {'(opens in new tab)'}
                          </span>
                        </a>
                      </li>
                      <li>{'Log in with your Steam account'}</li>
                      <li>
                        {
                          'Enter a domain name (can be "localhost" for personal use)'
                        }
                      </li>
                      <li>{'Copy the key and paste it here'}</li>
                    </ol>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="backups" className="mt-0 space-y-5">
            <Card id="settings-backups">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Archive className="w-4 h-4 text-primary" />
                      {'World Backups'}
                    </CardTitle>
                    <CardDescription>
                      {
                        "Save and restore your server's world, map, and player data."
                      }
                    </CardDescription>
                  </div>
                  <Button
                    onClick={handleCreateBackup}
                    disabled={creatingBackup || !backupStatus?.savesExists}
                    className="gap-2"
                  >
                    {creatingBackup ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Archive className="w-4 h-4" />
                    )}
                    {creatingBackup ? 'Creating...' : 'Backup Now'}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {backupStatus && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 bg-muted/50 rounded-xl">
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">
                        {backupStatus.savesExists ? (
                          <span className="text-primary">
                            {'Saves folder found'}
                          </span>
                        ) : (
                          <span className="text-destructive">
                            {'Saves folder not found'}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Archive className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">
                        {Number(backupStatus.backupCount) === 1
                          ? String(backupStatus.backupCount) + ' backup stored'
                          : String(backupStatus.backupCount) +
                            ' backups stored'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">
                        {backupStatus.lastBackup
                          ? 'Last: ' +
                            String(
                              new Date(
                                backupStatus.lastBackup.created,
                              ).toLocaleString('en'),
                            )
                          : 'No backups yet'}
                      </span>
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base">{'Scheduled Backups'}</Label>
                      <p className="text-sm text-muted-foreground">
                        {!backupStatus && backupStatusLoadError
                          ? "Couldn't check whether scheduled backups are on — this toggle is disabled until it loads. Reopen this page to try again."
                          : 'Automatically backup your world on a schedule'}
                      </p>
                    </div>
                    <Switch
                      checked={backupStatus?.enabled || false}
                      onCheckedChange={toggleBackupEnabled}
                      disabled={
                        backupLoading ||
                        (!backupStatus && backupStatusLoadError)
                      }
                      aria-label={'Enable scheduled backups'}
                    />
                  </div>

                  {backupStatus?.enabled && (
                    <div className="grid grid-cols-1 gap-4 border-s-2 border-primary/20 ps-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5">
                          <Label htmlFor="backup-schedule">{'Schedule'}</Label>
                          <HelpTip label={'Schedule'}>
                            {
                              'Each * means "any value". A couple of examples: "0 3 * * *" runs once a day at 3:00 AM; "0 */6 * * *" runs every 6 hours; "0 0 * * 0" runs once a week, at midnight on Sunday.'
                            }
                          </HelpTip>
                        </div>
                        <Input
                          id="backup-schedule"
                          value={backupSchedule}
                          onChange={(e) => setBackupSchedule(e.target.value)}
                          placeholder="0 */6 * * *"
                          className="font-mono"
                          maxLength={100}
                        />
                        <p className="text-xs text-muted-foreground">
                          {
                            'Default: every 6 hours. Uses cron format: minute hour day month weekday.'
                          }
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="backup-max">
                          {'Max Backups to Keep'}
                        </Label>
                        <NumberInput
                          id="backup-max"
                          min={1}
                          max={100}
                          value={backupMaxCount}
                          onChange={setBackupMaxCount}
                          onWheel={(e) => e.currentTarget.blur()}
                          className="max-w-24"
                        />
                        <p className="text-xs text-muted-foreground">
                          {
                            'The panel deletes the oldest backups when this limit is reached.'
                          }
                        </p>
                      </div>
                      <div className="sm:col-span-2">
                        <Button
                          onClick={handleSaveBackupSettings}
                          disabled={backupLoading}
                          variant="outline"
                          size="sm"
                        >
                          {backupLoading && (
                            <Loader2 className="w-4 h-4 me-2 animate-spin" />
                          )}
                          {'Save Schedule Settings'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-base font-medium">{'Existing Backups'}</p>
                  {backups.length === 0 ? (
                    <EmptyState
                      compact
                      type={backupsLoadError ? 'disconnected' : 'empty'}
                      title={
                        backupsLoadError
                          ? "Couldn't load backups"
                          : 'No backups yet'
                      }
                      description={
                        backupsLoadError
                          ? "This isn't necessarily an empty list — the backup list request failed. Reopen this page to try again."
                          : !backupStatus?.savesExists
                            ? "Backup Now is disabled because the saves folder wasn't found. Check the active server's Zomboid data path on the Servers page, then reopen this tab."
                            : 'Click "Backup Now" to create one.'
                      }
                    />
                  ) : (
                    <ScrollArea className="h-[200px] rounded-lg border">
                      <div className="p-2 space-y-2">
                        {backups.map((backup) => (
                          <div
                            key={backup.name}
                            className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <Archive className="w-4 h-4 text-primary flex-shrink-0" />
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {backup.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {formatBytes(backup.size)} •{' '}
                                  {new Date(backup.created).toLocaleString(
                                    'en',
                                  )}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <AlertDialog
                                open={restoreConfirmBackup === backup.name}
                                onOpenChange={(open) =>
                                  !open && setRestoreConfirmBackup(null)
                                }
                              >
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      setRestoreConfirmBackup(backup.name)
                                    }
                                    disabled={restoringBackup !== null}
                                    className="text-warning hover:text-warning hover:bg-warning/10"
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint; the "(server must be stopped)" parenthetical is a general precondition note, not tied to the actual disable condition (another restore already in progress, self-evident via the spinner). Triaged 2026-08-27.
                                    title={
                                      'Restore this backup (server must be stopped)'
                                    }
                                  >
                                    {restoringBackup === backup.name ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <RotateCcw className="w-4 h-4" />
                                    )}
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle className="flex items-center gap-2">
                                      <AlertTriangle className="w-5 h-5 text-warning" />
                                      {'Restore Backup'}
                                    </AlertDialogTitle>
                                    <AlertDialogDescription className="text-start space-y-2">
                                      <p>
                                        <>
                                          {'This will restore '}
                                          <strong>{backup.name}</strong>
                                          {' and '}
                                          <strong>{'OVERWRITE'}</strong>
                                          {' the current world data.'}
                                        </>
                                      </p>
                                      <ul className="list-disc list-inside text-sm space-y-1">
                                        <li>
                                          <>
                                            {'Server must be '}
                                            <strong>{'STOPPED'}</strong>
                                          </>
                                        </li>
                                        <li>
                                          {
                                            'A pre-restore backup will be created'
                                          }
                                        </li>
                                        <li>{'This cannot be undone'}</li>
                                      </ul>
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>
                                      {'Cancel'}
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        handleRestoreBackup(backup.name)
                                      }
                                      className="bg-warning text-warning-foreground hover:bg-warning/90"
                                    >
                                      {'Restore Backup'}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  backupApi.downloadBackup(backup.name)
                                }
                              >
                                <Download className="w-4 h-4" />
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>
                                      {'Delete Backup'}
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {'Are you sure you want to delete "' +
                                        String(backup.name) +
                                        '"? This action cannot be undone.'}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>
                                      {'Cancel'}
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        handleDeleteBackup(backup.name)
                                      }
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
                    </ScrollArea>
                  )}
                </div>

                {backupStatus?.savesPath && (
                  <div className="text-xs text-muted-foreground space-y-1">
                    <p>
                      <strong>{'Saves:'}</strong> {backupStatus.savesPath}
                    </p>
                    <p>
                      <strong>{'Backups:'}</strong> {backupStatus.backupsPath}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card id="settings-character-exports">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <User className="w-4 h-4 text-primary" />
                  {'Character Exports'}
                </CardTitle>
                <CardDescription>
                  {
                    'Per-player character copies, saved separately from world backups.'
                  }
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 p-3">
                  <div className="space-y-1">
                    <Label
                      htmlFor="auto-export-on-login"
                      className="text-sm font-medium"
                    >
                      {'Export a character when a player joins'}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {
                        'Runs about ten seconds after the player loads, so one character can be restored without rolling back the world. Needs PanelBridge connected.'
                      }
                    </p>
                  </div>
                  <Switch
                    id="auto-export-on-login"
                    checked={settings.autoExportOnLogin}
                    onCheckedChange={(value) =>
                      updateSetting('autoExportOnLogin', value)
                    }
                    aria-label={'Export a character when a player joins'}
                  />
                </div>
                {settings.autoExportOnLogin && (
                  <div className="max-w-xs space-y-1.5">
                    <Label htmlFor="auto-export-max">
                      {'Copies kept per player'}
                    </Label>
                    <Input
                      id="auto-export-max"
                      type="number"
                      min="1"
                      max="50"
                      inputMode="numeric"
                      value={settings.autoExportMaxPerPlayer}
                      onChange={(e) =>
                        updateSetting('autoExportMaxPerPlayer', e.target.value)
                      }
                      onWheel={(e) => e.currentTarget.blur()}
                    />
                    <p className="text-xs text-muted-foreground">
                      {
                        'Oldest exports are deleted once a player passes this count. Restore them from the Players page.'
                      }
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="mt-0">
            <Card id="settings-security">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-primary" />
                  {'Security & Authentication'}
                </CardTitle>
                <CardDescription>
                  {'Change your password and review access details.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {authEnabled && user && (
                  <div className="p-4 rounded-xl bg-muted/50 space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                        <User className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">{user.username}</p>
                      </div>
                    </div>
                  </div>
                )}

                {authEnabled && (
                  <div className="space-y-4">
                    <p className="text-base font-medium">{'Change Password'}</p>
                    <form
                      className="max-w-sm space-y-3"
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (changingPassword) return
                        if (
                          !currentPassword ||
                          !newPassword ||
                          !confirmPassword
                        )
                          return
                        if (newPassword !== confirmPassword) return
                        if (newPassword.length < 6) return
                        handleChangePassword()
                      }}
                    >
                      <input
                        type="text"
                        name="username"
                        value={user?.username || ''}
                        autoComplete="username"
                        readOnly
                        hidden
                      />
                      <div className="relative">
                        <Input
                          type={showCurrentPassword ? 'text' : 'password'}
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          placeholder={'Current password'}
                          className="h-11 pe-10"
                          maxLength={128}
                          autoComplete="current-password"
                          aria-label={'Current password'}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setShowCurrentPassword(!showCurrentPassword)
                          }
                          className="absolute right-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                          aria-label={
                            showCurrentPassword
                              ? 'Hide password'
                              : 'Show password'
                          }
                        >
                          {showCurrentPassword ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                      <div className="relative">
                        <Input
                          type={showNewPassword ? 'text' : 'password'}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder={'New password'}
                          className="h-11 pe-10"
                          maxLength={128}
                          autoComplete="new-password"
                          aria-label={'New password'}
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute right-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                          aria-label={
                            showNewPassword ? 'Hide password' : 'Show password'
                          }
                        >
                          {showNewPassword ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                      <Input
                        type={showNewPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder={'Confirm new password'}
                        className="h-11"
                        maxLength={128}
                        autoComplete="new-password"
                        aria-label={'Confirm new password'}
                      />
                      {newPassword &&
                        confirmPassword &&
                        newPassword !== confirmPassword && (
                          <p
                            className="text-xs text-destructive flex items-center gap-1"
                            role="alert"
                          >
                            <XCircle className="w-3 h-3" />{' '}
                            {'Passwords do not match'}
                          </p>
                        )}
                      {newPassword && newPassword.length < 6 && (
                        <p
                          className="text-xs text-destructive flex items-center gap-1"
                          role="alert"
                        >
                          <XCircle className="w-3 h-3" />{' '}
                          {'Password must be at least 6 characters'}
                        </p>
                      )}
                      <Button
                        type="submit"
                        disabled={
                          changingPassword ||
                          !currentPassword ||
                          !newPassword ||
                          !confirmPassword ||
                          newPassword !== confirmPassword ||
                          newPassword.length < 6
                        }
                        className="gap-2"
                      >
                        {changingPassword ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Key className="w-4 h-4" />
                        )}
                        {changingPassword ? 'Changing...' : 'Change Password'}
                      </Button>
                    </form>

                    <div className="max-w-2xl rounded-xl border border-border/70 bg-muted/35 p-4 text-sm text-muted-foreground">
                      <div className="flex items-start gap-3">
                        <Info className="mt-0.5 h-4 w-4 text-primary" />
                        <div className="space-y-1.5 leading-6">
                          <p className="font-medium text-foreground">
                            {'Recovery when the current password is lost'}
                          </p>
                          {localPasswordResetSupported ? (
                            <>
                              <p>
                                {
                                  'This panel session is running from the server itself, so you can reset the password here without typing the current one.'
                                }
                              </p>
                              <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="sm:w-auto"
                                  onClick={() =>
                                    void handlePrepareLocalPasswordReset()
                                  }
                                  disabled={
                                    preparingLocalPasswordReset ||
                                    resettingLocalPassword
                                  }
                                >
                                  {preparingLocalPasswordReset ? (
                                    <Loader2 className="me-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <Key className="me-2 h-4 w-4" />
                                  )}
                                  {showLocalPasswordReset
                                    ? 'Refresh Local Recovery'
                                    : 'Reset Password On This Server'}
                                </Button>
                                {showLocalPasswordReset && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="sm:w-auto"
                                    onClick={() => {
                                      setShowLocalPasswordReset(false)
                                      setLocalPasswordResetToken('')
                                      setLocalPasswordResetPassword('')
                                      setLocalPasswordResetConfirm('')
                                    }}
                                    disabled={
                                      preparingLocalPasswordReset ||
                                      resettingLocalPassword
                                    }
                                  >
                                    {'Hide'}
                                  </Button>
                                )}
                              </div>
                              {showLocalPasswordReset && (
                                <form
                                  className="max-w-sm space-y-3 pt-2"
                                  onSubmit={(e) => {
                                    e.preventDefault()
                                    if (resettingLocalPassword) return
                                    void handleResetLostPassword()
                                  }}
                                >
                                  <Input
                                    type="text"
                                    value={localPasswordResetToken}
                                    onChange={(e) =>
                                      setLocalPasswordResetToken(e.target.value)
                                    }
                                    placeholder={
                                      'Paste the token from data/reset-token.txt'
                                    }
                                    className="h-11"
                                    autoComplete="off"
                                    aria-label={
                                      'Recovery token for local reset'
                                    }
                                  />
                                  <div className="relative">
                                    <Input
                                      type={
                                        showLocalResetPassword
                                          ? 'text'
                                          : 'password'
                                      }
                                      value={localPasswordResetPassword}
                                      onChange={(e) =>
                                        setLocalPasswordResetPassword(
                                          e.target.value,
                                        )
                                      }
                                      placeholder={'New password'}
                                      className="h-11 pe-10"
                                      maxLength={128}
                                      autoComplete="new-password"
                                      aria-label={
                                        'New password for local reset'
                                      }
                                    />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setShowLocalResetPassword(
                                          !showLocalResetPassword,
                                        )
                                      }
                                      className="absolute right-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                                      aria-label={
                                        showLocalResetPassword
                                          ? 'Hide password'
                                          : 'Show password'
                                      }
                                    >
                                      {showLocalResetPassword ? (
                                        <EyeOff className="w-4 h-4" />
                                      ) : (
                                        <Eye className="w-4 h-4" />
                                      )}
                                    </button>
                                  </div>
                                  <Input
                                    type={
                                      showLocalResetPassword
                                        ? 'text'
                                        : 'password'
                                    }
                                    value={localPasswordResetConfirm}
                                    onChange={(e) =>
                                      setLocalPasswordResetConfirm(
                                        e.target.value,
                                      )
                                    }
                                    placeholder={'Confirm new password'}
                                    className="h-11"
                                    maxLength={128}
                                    autoComplete="new-password"
                                    aria-label={
                                      'Confirm new password for local reset'
                                    }
                                  />
                                  {localPasswordResetPassword &&
                                    localPasswordResetConfirm &&
                                    localPasswordResetPassword !==
                                      localPasswordResetConfirm && (
                                      <p
                                        className="text-xs text-destructive flex items-center gap-1"
                                        role="alert"
                                      >
                                        <XCircle className="w-3 h-3" />{' '}
                                        {'Passwords do not match'}
                                      </p>
                                    )}
                                  {localPasswordResetPassword &&
                                    localPasswordResetPassword.length < 6 && (
                                      <p
                                        className="text-xs text-destructive flex items-center gap-1"
                                        role="alert"
                                      >
                                        <XCircle className="w-3 h-3" />{' '}
                                        {
                                          'Password must be at least 6 characters'
                                        }
                                      </p>
                                    )}
                                  <Button
                                    type="submit"
                                    className="gap-2"
                                    disabled={
                                      resettingLocalPassword ||
                                      preparingLocalPasswordReset ||
                                      !localPasswordResetToken ||
                                      !localPasswordResetPassword ||
                                      !localPasswordResetConfirm ||
                                      localPasswordResetPassword !==
                                        localPasswordResetConfirm ||
                                      localPasswordResetPassword.length < 6
                                    }
                                  >
                                    {resettingLocalPassword ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Key className="w-4 h-4" />
                                    )}
                                    {resettingLocalPassword
                                      ? 'Resetting...'
                                      : 'Reset Password and Sign Out'}
                                  </Button>
                                </form>
                              )}
                            </>
                          ) : (
                            <>
                              <p>
                                <>
                                  {
                                    'The panel cannot show existing passwords. If you still have filesystem access to the panel host, sign out and either create '
                                  }
                                  {'data/reset-token.txt'}
                                  {' or start the panel with '}
                                  {'--reset-password'}
                                  {'.'}
                                </>
                              </p>
                              <p>
                                {
                                  'Once the token file exists, the login screen will show a recovery option so you can set a new admin password without knowing the old one.'
                                }
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {user && (
                      <div className="max-w-2xl rounded-xl border border-destructive/40 bg-destructive/5 p-4 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">
                              {'Regenerate JWT secret'}
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {
                                'Immediately signs out every user on every device, including you — access and refresh tokens for every current session stop working at once. Use this only if a backup containing the old signing key may have leaked; it is not a routine action and there is no automatic rotation.'
                              }
                            </p>
                          </div>
                          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                        </div>
                        <AlertDialog
                          open={regenerateJwtDialogOpen}
                          onOpenChange={setRegenerateJwtDialogOpen}
                        >
                          <AlertDialogTrigger asChild>
                            <Button type="button" variant="destructive">
                              <RefreshCw className="me-2 h-4 w-4" />
                              {'Regenerate JWT Secret'}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle className="flex items-center gap-2">
                                <AlertTriangle className="h-5 w-5 text-destructive" />
                                {'Regenerate the JWT secret?'}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {
                                  'This signs out every user on every device right now, including your own session — you will need to log back in immediately afterward. This cannot be undone.'
                                }
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel
                                disabled={regeneratingJwtSecret}
                              >
                                {'Cancel'}
                              </AlertDialogCancel>
                              <AlertDialogAction
                                onClick={(e) => {
                                  e.preventDefault()
                                  void handleRegenerateJwtSecret()
                                }}
                                disabled={regeneratingJwtSecret}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                {regeneratingJwtSecret ? (
                                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                                ) : null}
                                {'Yes, sign out everyone'}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-3 text-sm text-muted-foreground pt-2 border-t">
                  <p>
                    <strong className="text-foreground">
                      {'RCON Security:'}
                    </strong>{' '}
                    {
                      'Your RCON password is stored locally and is never transmitted outside of the RCON connection to your server.'
                    }
                  </p>
                  <p>
                    <strong className="text-foreground">
                      {'Admin Commands:'}
                    </strong>{' '}
                    {
                      'Be careful with admin commands. Some actions like banning or kicking players cannot be easily undone.'
                    }
                  </p>
                  {!authEnabled && (
                    <p>
                      <strong className="text-foreground">
                        {'Authentication:'}
                      </strong>{' '}
                      {
                        'Authentication is not configured. Create an account via the setup wizard on first launch to protect access to this panel.'
                      }
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="about" className="mt-0 space-y-5">
            <Card id="settings-elsewhere">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <ExternalLink className="w-4 h-4 text-primary" />
                  {'Settings kept on other pages'}
                </CardTitle>
                <CardDescription>
                  {
                    'These features own their own configuration, so it lives with the feature instead of here.'
                  }
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border/50">
                  {[
                    {
                      href: '/servers',
                      label: 'Server profiles',
                      detail:
                        'Install paths, RCON host and password, memory, and SteamCMD.',
                    },
                    {
                      href: '/discord',
                      label: 'Discord bot',
                      detail:
                        'Bot token, channels, event notifications, and the chat bridge.',
                    },
                    {
                      href: '/scheduler',
                      label: 'Scheduled tasks',
                      detail:
                        'Restarts, announcements, and recurring commands.',
                    },
                    {
                      href: '/server-config',
                      label: 'Game server config',
                      detail: 'Server INI options and sandbox rules.',
                    },
                    {
                      href: '/chat',
                      label: 'Chat quick messages',
                      detail: 'Preset messages shown above the chat input.',
                    },
                  ].map((item) => (
                    <li key={item.href}>
                      <RouterLink
                        to={item.href}
                        className="flex items-center justify-between gap-4 py-2.5 group"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-foreground group-hover:text-primary">
                            {item.label}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {item.detail}
                          </span>
                        </span>
                        <ExternalLink
                          className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60 group-hover:text-primary"
                          aria-hidden="true"
                        />
                      </RouterLink>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card id="settings-about">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-primary" />
                  {'About'}
                </CardTitle>
                <CardDescription>
                  {'Panel version, runtime info, and helpful links.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                        {'Installed version'}
                      </p>
                      <p className="text-lg font-semibold tabular-nums">
                        v{panelUpdateStatus?.currentVersion || '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                        {'Latest available'}
                      </p>
                      <p className="text-lg font-semibold tabular-nums flex items-center gap-2">
                        {panelUpdateStatus?.latestVersion ? (
                          <>
                            v{panelUpdateStatus.latestVersion}
                            {panelUpdateStatus.updateAvailable ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                                {'Update available'}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                                {'Up to date'}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground text-base font-normal">
                            {'Not checked yet'}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">
                  {
                    'A web-based management panel for Project Zomboid dedicated servers. Includes RCON, player management, mod update detection, scheduled restarts, world backups, Discord integration, and the PanelBridge Lua mod for in-world actions.'
                  }
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  <a
                    href="https://discord.gg/jHsWJDNmSg"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-[#5865F2]/40 bg-[#5865F2]/10 px-3 py-2 text-sm text-[#5865F2] hover:bg-[#5865F2]/20 transition-colors"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    {'Join Discord'}
                  </a>
                  <a
                    href="https://github.com/itsmeares/better-zcp"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                    {'GitHub repository'}
                  </a>
                  <a
                    href="https://github.com/itsmeares/better-zcp/releases"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                    {'Releases & changelog'}
                  </a>
                  <a
                    href="https://github.com/itsmeares/better-zcp/issues"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                    {'Report an issue'}
                  </a>
                </div>

                <div className="pt-4 border-t border-border/40 text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span>{'Built with React, Node.js, and Socket.IO'}</span>
                  <span aria-hidden="true">·</span>
                  <a
                    href="https://github.com/itsmeares/better-zcp/blob/main/LICENSE"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {'AGPL-3.0-only'}
                  </a>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </div>
      </Tabs>

      <AlertDialog
        open={pendingCorsLanDisable}
        onOpenChange={setPendingCorsLanDisable}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {'Lock yourself out of the panel?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <>
                {'Disabling '}
                <strong>{'Allow Private/LAN Origins'}</strong>
                {' with no explicit origins listed and '}
                <strong>{'Allow All Origins'}</strong>
                {
                  " off will block every browser connection — including the one you're using right now — after the next CORS reload."
                }
              </>
              <br />
              <br />
              <>
                {'To recover, you would need to restart the panel with the '}
                <code className="mx-1">{'CORS_ORIGINS'}</code>
                {' environment variable set to a valid origin (e.g. '}
                <code className="mx-1">
                  {'CORS_ORIGINS=https://panel.example.com'}
                </code>
                {').'}
              </>
              <br />
              <br />
              {
                'Add at least one origin in the box above first, then disable LAN access.'
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{'Keep LAN access on'}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                updateSetting('corsAllowPrivateNetworks', false)
                setPendingCorsLanDisable(false)
              }}
            >
              {'Disable anyway'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function WorkshopCollectionSyncCard({
  settings,
  updateSetting,
  persistCookies,
}: {
  settings: AppSettings
  updateSetting: (
    key: keyof AppSettings,
    value: AppSettings[keyof AppSettings],
  ) => void
  persistCookies: (
    cookies: Pick<AppSettings, 'steamSessionId' | 'steamLoginSecure'>,
  ) => Promise<void>
}) {
  const { toast } = useToast()
  const [diff, setDiff] = useState<Awaited<
    ReturnType<typeof modsApi.collectionDiff>
  > | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffCheckedAt, setDiffCheckedAt] = useState<Date | null>(null)
  const [browsers, setBrowsers] = useState<Awaited<
    ReturnType<typeof modsApi.collectionBrowsers>
  > | null>(null)
  const [extractingFrom, setExtractingFrom] = useState<string | null>(null)
  const [savingCookies, setSavingCookies] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showCookies, setShowCookies] = useState(false)

  const [itemFilter, setItemFilter] = useState<
    | 'all'
    | 'missing'
    | 'not-on-server'
    | 'tracked-only'
    | 'synced'
    | 'tracked'
    | 'collection'
  >('missing')
  const [itemSearch, setItemSearch] = useState('')
  const [rowBusy, setRowBusy] = useState<Record<string, string | null>>({})
  const [purgeTarget, setPurgeTarget] = useState<{
    workshopId: string
    name: string | null
  } | null>(null)
  const [removeServerTarget, setRemoveServerTarget] = useState<{
    workshopId: string
  } | null>(null)

  const credsConfigured = (() => {
    if (diff && typeof diff.hasCredentials === 'boolean')
      return diff.hasCredentials
    const a = settings.steamSessionId || ''
    const b = settings.steamLoginSecure || ''
    return (
      (a.startsWith('•') || a.length >= 8) &&
      (b.startsWith('•') || b.length >= 16)
    )
  })()
  const tokenExpired = !!diff?.tokenExpired

  const collectionId = (settings.workshopCollectionId || '').trim()
  const collectionIdValid = /^\d{1,15}$/.test(collectionId)
  const autoSyncOn = !!settings.workshopCollectionAutoSync

  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  const clipboardReadAvailable =
    typeof navigator !== 'undefined' &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.readText === 'function' &&
    (window.isSecureContext ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1')

  const safeDecode = (v: string): string => {
    try {
      return decodeURIComponent(v)
    } catch {
      return v
    }
  }

  const parseCookieBlob = (
    raw: string,
  ): { sessionId?: string; loginSecure?: string; error?: string } => {
    if (!raw || !raw.trim()) return { error: 'Nothing to parse' }
    const text = raw.replace(/\r/g, '')
    const sessionMatch = text.match(
      /(?:^|[;\s'"])sessionid\s*[=:\t]\s*([A-Za-z0-9_%-]+)/i,
    )
    const loginMatch = text.match(
      /(?:^|[;\s'"])steamLoginSecure\s*[=:\t]\s*([A-Za-z0-9_%|+/=.-]+)/i,
    )
    if (!sessionMatch && !loginMatch) {
      return { error: 'No sessionid or steamLoginSecure found in pasted text' }
    }
    const result: { sessionId?: string; loginSecure?: string } = {}
    if (sessionMatch) result.sessionId = safeDecode(sessionMatch[1])
    if (loginMatch) result.loginSecure = safeDecode(loginMatch[1])
    return result
  }

  const saveExtractedCookies = async (
    sessionId: string,
    loginSecure: string,
  ) => {
    setSavingCookies(true)
    try {
      await persistCookies({
        steamSessionId: sessionId,
        steamLoginSecure: loginSecure,
      })
      toast({
        title: 'Cookies saved',
        description: 'Your Steam session is ready for collection sync.',
        variant: 'success' as const,
      })
      return true
    } catch (error) {
      setPasteError(
        getUserErrorMessage(error, 'Could not save cookies. Try again.'),
      )
      return false
    } finally {
      setSavingCookies(false)
    }
  }

  const handlePasteApply = async () => {
    setPasteError(null)
    const parsed = parseCookieBlob(pasteText)
    if (parsed.error) {
      setPasteError(parsed.error)
      return
    }
    if (!parsed.sessionId && !parsed.loginSecure) {
      setPasteError('Nothing usable found')
      return
    }
    const { sessionId, loginSecure } = parsed
    if (sessionId && loginSecure) {
      if (await saveExtractedCookies(sessionId, loginSecure)) {
        setPasteText('')
        setPasteOpen(false)
      }
      return
    }
    if (parsed.sessionId) updateSetting('steamSessionId', parsed.sessionId)
    if (parsed.loginSecure)
      updateSetting('steamLoginSecure', parsed.loginSecure)
    toast({
      title: 'Partial extraction',
      description:
        'Only ' +
        String(parsed.sessionId ? 'sessionid' : 'steamLoginSecure') +
        ' found — paste a request that includes both, or fill the other field manually.',
      variant: 'destructive',
    })
    setPasteText('')
    setPasteOpen(false)
  }

  const handlePasteFromClipboard = async () => {
    setPasteError(null)
    if (!clipboardReadAvailable) {
      setPasteOpen(true)
      setPasteError(
        'Clipboard read needs HTTPS or localhost. Use manual paste below.',
      )
      return
    }
    try {
      const text = await navigator.clipboard.readText()
      if (!text) {
        setPasteOpen(true)
        setPasteError('Clipboard is empty')
        return
      }
      const parsed = parseCookieBlob(text)
      const { sessionId, loginSecure } = parsed
      if (sessionId && loginSecure) {
        if (await saveExtractedCookies(sessionId, loginSecure)) {
          setPasteText('')
          setPasteOpen(false)
        }
        return
      }
      setPasteText(text)
      setPasteOpen(true)
      setPasteError(
        parsed.error ||
          'Couldn’t find both cookies in the clipboard. Paste a request that includes them.',
      )
    } catch (err: any) {
      setPasteOpen(true)
      setPasteError(
        getUserErrorMessage(
          err,
          'Could not read clipboard. Paste manually instead.',
        ),
      )
    }
  }

  const refreshDiffSeqRef = useRef(0)
  const refreshDiff = useCallback(async () => {
    if (!collectionIdValid) return
    const seq = ++refreshDiffSeqRef.current
    setDiffLoading(true)
    setDiffError(null)
    try {
      const r = await modsApi.collectionDiff()
      if (seq !== refreshDiffSeqRef.current) return
      setDiff(r)
      setDiffCheckedAt(new Date())
      if (!r.ok && r.error) setDiffError(r.error)
    } catch (err: any) {
      if (seq !== refreshDiffSeqRef.current) return
      setDiffError(getUserErrorMessage(err, 'Failed to read collection'))
    } finally {
      if (seq === refreshDiffSeqRef.current) setDiffLoading(false)
    }
  }, [collectionIdValid])

  useEffect(() => {
    if (collectionIdValid && !diff && !diffLoading && !diffError) {
      refreshDiff()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionIdValid])

  useEffect(() => {
    let cancelled = false
    modsApi
      .collectionBrowsers()
      .then((r) => {
        if (!cancelled) setBrowsers(r)
      })
      .catch(() => {
        /* not fatal — the section just won't appear */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleAutoExtract = async (browserId: string, label: string) => {
    if (extractingFrom) return
    setExtractingFrom(browserId)
    try {
      const r = await modsApi.collectionExtractCookies(browserId)
      if (r.ok && r.saved) {
        toast({
          title: 'Cookies saved',
          description: 'Your Steam session is ready for collection sync.',
          variant: 'success' as const,
        })
        if (r.notes && r.notes.length > 0) {
          toast({
            title: 'Cookies extracted from ' + String(label),
            description: r.notes[0],
          })
        }
        await refreshDiff()
      } else {
        toast({
          variant: 'destructive',
          title: "Couldn't extract from " + String(label),
          description: r.error || 'Unknown failure',
        })
      }
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: "Couldn't extract from " + String(label),
        description: getUserErrorMessage(err, 'Request failed'),
      })
    } finally {
      setExtractingFrom(null)
    }
  }

  const handleTest = async () => {
    if (testing) return
    setTesting(true)
    try {
      const r = await modsApi.collectionTest()
      toast({ title: 'Connection OK', description: r.message })
      await refreshDiff()
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Test failed',
        description: getUserErrorMessage(err, 'Could not reach collection'),
      })
    } finally {
      setTesting(false)
    }
  }

  const allItems = diff?.ok && Array.isArray(diff.items) ? diff.items : []
  const missingCount = allItems.filter((it) => it.status === 'to-add').length
  const notOnServerCount = allItems.filter(
    (it) => it.status === 'collection-only',
  ).length
  const trackedOnlyCount = allItems.filter(
    (it) => it.status === 'tracked-only',
  ).length
  const syncedCount = allItems.filter((it) => it.status === 'synced').length
  const driftCount = missingCount + notOnServerCount + trackedOnlyCount
  const inSync = !!diff?.ok && driftCount === 0
  const filteredItems = allItems.filter((it) => {
    if (itemFilter === 'missing' && it.status !== 'to-add') return false
    if (itemFilter === 'not-on-server' && it.status !== 'collection-only')
      return false
    if (itemFilter === 'tracked-only' && it.status !== 'tracked-only')
      return false
    if (itemFilter === 'synced' && it.status !== 'synced') return false
    if (itemFilter === 'tracked' && !it.inTracked) return false
    if (itemFilter === 'collection' && !it.inCollection) return false
    if (itemSearch.trim()) {
      const q = itemSearch.trim().toLowerCase()
      if (
        !it.workshopId.includes(q) &&
        !(it.name || '').toLowerCase().includes(q)
      )
        return false
    }
    return true
  })

  const runRowAction = async (
    workshopId: string,
    action:
      | 'add'
      | 'remove'
      | 'track'
      | 'untrack'
      | 'add-server'
      | 'remove-server'
      | 'purge',
    name?: string | null,
  ) => {
    setRowBusy((prev) => ({ ...prev, [workshopId]: action }))
    try {
      if (action === 'add') {
        if (!credsConfigured)
          throw new Error('Add Steam cookies first to write to the collection.')
        if (tokenExpired)
          throw new Error(
            'Steam session expired. Paste fresh cookies above and try again.',
          )
        await modsApi.collectionAddItem(workshopId)
      } else if (action === 'remove') {
        if (!credsConfigured)
          throw new Error('Add Steam cookies first to write to the collection.')
        if (tokenExpired)
          throw new Error(
            'Steam session expired. Paste fresh cookies above and try again.',
          )
        await modsApi.collectionRemoveItem(workshopId)
      } else if (action === 'track') {
        await modsApi.trackMod(workshopId)
      } else if (action === 'untrack') {
        await modsApi.untrackMod(workshopId)
      } else if (action === 'add-server') {
        await modsApi.addToIni(workshopId)
        if (!allItems.find((it) => it.workshopId === workshopId)?.inTracked) {
          await modsApi.trackMod(workshopId)
        }
        toast({
          title: 'Added to the server',
          description:
            'Project Zomboid will download and load this mod on the next server restart.',
        })
      } else if (action === 'remove-server') {
        await modsApi.batchRemove([workshopId])
        toast({
          title: 'Removed from the server',
          description: diff?.autoSync
            ? 'It will also be removed from the Steam collection.'
            : 'The Steam collection was left unchanged because auto-sync is off.',
        })
      } else if (action === 'purge') {
        const r = await modsApi.purgeMod(workshopId, name)
        const done = [
          r.collection.attempted
            ? r.collection.ok
              ? 'removed from the collection'
              : 'collection not updated (' +
                String(r.collection.error || 'Steam rejected the change') +
                ')'
            : null,
          'removed from the server config',
          r.deletedFromDisk ? 'deleted from disk' : 'no files on disk',
          'untracked and ignored',
        ].filter(Boolean)
        toast({
          title: 'Removed ' + String(r.name || workshopId) + ' everywhere',
          description: `${done.join(', ')}.`,
        })
      }
      await refreshDiff()
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Action failed',
        description: getUserErrorMessage(err, 'Steam rejected the change'),
      })
    } finally {
      setRowBusy((prev) => {
        const next = { ...prev }
        delete next[workshopId]
        return next
      })
    }
  }

  return (
    <Card id="settings-workshop-collection">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-primary" />
          {'Workshop Collection Sync'}
        </CardTitle>
        <CardDescription>
          {
            'Mirror your tracked-mod list into a Steam Workshop collection so add/remove only happens in one place.'
          }
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-7">
        <div className="grid gap-6 border-b border-border/40 pb-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,.8fr)]">
          <div className="space-y-2 lg:order-1">
            <Label htmlFor="ws-collection-id" className="text-base">
              {'Collection ID'}
            </Label>
            <Input
              id="ws-collection-id"
              value={settings.workshopCollectionId}
              onChange={(e) =>
                updateSetting('workshopCollectionId', e.target.value.trim())
              }
              placeholder={'e.g. 3123456789'}
              className="h-11 max-w-md font-mono"
              maxLength={20}
            />
            <p className="text-sm text-muted-foreground">
              <>
                {
                  'Open your collection on Steam and copy the numeric ID from the URL (the digits after '
                }
                <code>{'?id='}</code>
                {'). You must own the collection.'}
              </>
            </p>
          </div>

          <div
            className={`flex items-start justify-between gap-4 lg:order-2 lg:border-s lg:border-border/40 lg:ps-6 ${
              autoSyncOn && !credsConfigured ? 'text-warning' : ''
            }`}
          >
            <div className="space-y-1">
              <Label className="text-base">{'Auto-sync on add / remove'}</Label>
              <p className="text-sm text-muted-foreground">
                {
                  "When you track or untrack a mod, the panel updates the collection in the background. Failures are logged but don't block your action."
                }
              </p>
              {autoSyncOn && !credsConfigured && (
                <p className="text-xs text-warning flex items-center gap-1 pt-1">
                  <AlertTriangle className="w-3 h-3" />
                  {
                    'Auto-sync needs Steam session cookies below to actually push changes.'
                  }
                </p>
              )}
              {autoSyncOn && !collectionIdValid && (
                <p className="text-xs text-warning flex items-center gap-1 pt-1">
                  <AlertTriangle className="w-3 h-3" />
                  {'Set a Collection ID first — nothing to sync to yet.'}
                </p>
              )}
            </div>
            <Switch
              checked={autoSyncOn}
              onCheckedChange={(v) =>
                updateSetting('workshopCollectionAutoSync', v)
              }
            />
          </div>
        </div>

        {collectionIdValid ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Label className="text-base">{'Steam Session Cookies'}</Label>
                {credsConfigured ? (
                  <span className="inline-flex items-center gap-1 rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">
                    <Check className="w-3 h-3" /> {'Configured'}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded border border-muted-foreground/30 bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {'Not configured'}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowCookies((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                {showCookies ? (
                  <EyeOff className="w-3.5 h-3.5" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
                {showCookies ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className="text-sm text-muted-foreground">
              <>
                {'Required to '}
                <strong>{'write'}</strong>
                {' to the collection. Reading is free without these.'}
              </>
            </p>
            <div className="grid gap-3 sm:grid-cols-2 max-w-3xl">
              <div className="space-y-1">
                <Label
                  htmlFor="ws-sessionid"
                  className="text-xs text-muted-foreground"
                >
                  {'sessionid'}
                </Label>
                <Input
                  id="ws-sessionid"
                  type={showCookies ? 'text' : 'password'}
                  value={settings.steamSessionId}
                  onChange={(e) =>
                    updateSetting('steamSessionId', e.target.value.trim())
                  }
                  placeholder={'24-char hex from cookie'}
                  className="h-10 font-mono"
                  maxLength={64}
                />
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor="ws-loginsecure"
                  className="text-xs text-muted-foreground"
                >
                  {'steamLoginSecure'}
                </Label>
                <Input
                  id="ws-loginsecure"
                  type={showCookies ? 'text' : 'password'}
                  value={settings.steamLoginSecure}
                  onChange={(e) =>
                    updateSetting('steamLoginSecure', e.target.value.trim())
                  }
                  placeholder={'long token from cookie'}
                  className="h-10 font-mono"
                  maxLength={512}
                />
              </div>
            </div>
            {browsers &&
              browsers.supported &&
              browsers.browsers.some((b) => b.detected) && (
                <div className="border-t border-border/40 pt-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <div className="flex-1 space-y-1">
                      <p className="font-medium text-sm">
                        {"Auto-detect from this machine's browser"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <>
                          {
                            'Reads cookies directly from a browser installed on the panel host. Works for browsers logged into Steam on '
                          }
                          <strong>{'this machine'}</strong>
                          {'. Close the browser first for best results.'}
                        </>
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {browsers.browsers
                      .filter((b) => b.detected)
                      .map((b) => (
                        <Button
                          key={b.id}
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!!extractingFrom}
                          onClick={() => handleAutoExtract(b.id, b.label)}
                        >
                          {extractingFrom === b.id ? (
                            <RefreshCw className="w-3.5 h-3.5 me-1.5 animate-spin" />
                          ) : (
                            <Check className="w-3.5 h-3.5 me-1.5" />
                          )}
                          {b.label}
                        </Button>
                      ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    <>
                      {'Chrome 127+ may seal '}
                      <code>{'steamLoginSecure'}</code>
                      {
                        ' away from this method (App-Bound Encryption). Paste a Steam request if extraction returns nothing.'
                      }
                    </>
                  </p>
                </div>
              )}

            <div className="border-t border-border/40 pt-4 space-y-3">
              <div className="flex items-start gap-3">
                <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <div className="flex-1 space-y-1">
                  <p className="font-medium text-sm">
                    {'Quick setup: paste a Steam request'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <>
                      {'Steam marks '}
                      <code>{'steamLoginSecure'}</code>
                      {
                        " as HttpOnly, so the cookies tab works but a one-click button can't read it. Easiest path: copy any logged-in Steam request and let us extract the cookies."
                      }
                    </>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {'Prefer a cookie exporter?'}{' '}
                    <a
                      href="https://github.com/kairi003/Get-cookies.txt-LOCALLY"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {'Get cookies.txt LOCALLY'}
                      <ExternalLink className="w-3 h-3" />
                    </a>{' '}
                    <>
                      {
                        '(Chrome/Firefox, open source) works well on Steam. Open '
                      }
                      <code>{'steamcommunity.com'}</code>
                      {
                        ' while signed in, click its icon, copy, and paste the result below — both its '
                      }
                      <em>{'Netscape'}</em>
                      {' and '}
                      <em>{'Header String'}</em>
                      {' formats are understood.'}
                    </>
                  </p>
                </div>
              </div>

              {!pasteOpen ? (
                <div className="flex flex-wrap gap-2">
                  {clipboardReadAvailable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={handlePasteFromClipboard}
                      disabled={savingCookies}
                    >
                      <Cloud className="w-3.5 h-3.5 me-1.5" />
                      {'Paste from clipboard'}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant={clipboardReadAvailable ? 'outline' : 'default'}
                    onClick={() => {
                      setPasteOpen(true)
                      setPasteError(null)
                    }}
                  >
                    {clipboardReadAvailable
                      ? 'Paste manually…'
                      : 'Paste cookies…'}
                  </Button>
                  <a
                    href="https://steamcommunity.com/my/myworkshopfiles/?section=collections"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline self-center"
                  >
                    {'Open Steam collections'}{' '}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              ) : (
                <div className="space-y-2">
                  <Textarea
                    value={pasteText}
                    onChange={(e) => {
                      setPasteText(e.target.value)
                      setPasteError(null)
                    }}
                    placeholder={
                      'Paste a "Copy as cURL" command, a Cookie header, a cookies.txt export, or "sessionid=...; steamLoginSecure=..."'
                    }
                    rows={4}
                    className="font-mono text-xs"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={handlePasteApply}
                      disabled={!pasteText.trim() || savingCookies}
                    >
                      {savingCookies ? (
                        <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5 me-1.5" />
                      )}
                      {savingCookies ? 'Saving…' : 'Extract & save'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setPasteOpen(false)
                        setPasteText('')
                        setPasteError(null)
                      }}
                    >
                      {'Cancel'}
                    </Button>
                  </div>
                  {pasteError && (
                    <p className="text-xs text-destructive flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> {pasteError}
                    </p>
                  )}
                </div>
              )}

              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  {'How to get a Steam request to copy'}
                </summary>
                <ol className="list-decimal list-inside mt-2 space-y-1 text-muted-foreground ps-1">
                  <li>
                    {'Open steamcommunity.com in your browser, logged in.'}
                  </li>
                  <li>
                    {'Press'}{' '}
                    <kbd className="px-1 py-0.5 rounded border bg-muted text-[10px]">
                      F12
                    </kbd>{' '}
                    <>
                      {'→ '}
                      <strong>{'Network'}</strong>
                      {' tab.'}
                    </>
                  </li>
                  <li>{'Reload the page so requests show up.'}</li>
                  <li>
                    <>
                      {'Right-click '}
                      <em>{'any'}</em>
                      {' request → '}
                      <strong>{'Copy'}</strong>
                      {' → '}
                      <strong>{'Copy as cURL'}</strong>
                      {'.'}
                    </>
                  </li>
                  <li>
                    <>
                      {'Come back here and click '}
                      <strong>{'Paste from clipboard'}</strong>
                      {'.'}
                    </>
                  </li>
                </ol>
                <p className="mt-2 text-muted-foreground">
                  <>
                    {'Or, if you prefer the manual route: F12 → '}
                    <strong>{'Application'}</strong>
                    {' → '}
                    <strong>{'Cookies'}</strong>
                    {' → '}
                    <code className="mx-1">{'https://steamcommunity.com'}</code>
                    {', copy '}
                    <code className="mx-1">{'sessionid'}</code>
                    {' and '}
                    <code className="mx-1">{'steamLoginSecure'}</code>
                    {' into the fields above directly.'}
                  </>
                </p>
              </details>

              <p className="text-[11px] text-warning/90 flex items-start gap-1 pt-1 border-t border-border/30">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>
                  {
                    "These cookies grant Steam login access — treat them like a password. Steam rotates the token every few weeks, so you'll need to re-paste when sync starts failing."
                  }
                </span>
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-background/40 p-4 text-sm text-muted-foreground">
            <KeyRound
              className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground/70"
              aria-hidden="true"
            />
            <p>
              {'Enter a Collection ID above to set up Steam session cookies.'}
            </p>
          </div>
        )}

        <div className="space-y-2 pt-2 border-t border-border/40">
          <div className="flex flex-wrap items-center gap-2">
            <DisabledReason
              reason={
                !credsConfigured ? 'Add Steam session cookies first' : null
              }
            >
              <Button
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={!collectionIdValid || !credsConfigured || testing}
                // eslint-disable-next-line local/no-dead-disabled-title -- This title describes the action, not why it is disabled.
                title={
                  !credsConfigured
                    ? undefined
                    : 'Verify the collection is readable with these cookies'
                }
              >
                {testing ? (
                  <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 me-1.5" />
                )}
                {'Test connection'}
              </Button>
            </DisabledReason>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshDiff}
              disabled={!collectionIdValid || diffLoading}
            >
              {diffLoading ? (
                <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 me-1.5" />
              )}
              {'Check drift'}
            </Button>

            <div className="ms-auto text-xs text-muted-foreground">
              {diffError ? (
                <span className="text-destructive flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {diffError}
                </span>
              ) : !collectionIdValid ? (
                <span>{'Enter a Collection ID to begin.'}</span>
              ) : !diff ? (
                <span>
                  {diffLoading
                    ? 'Reading collection…'
                    : 'Click "Check drift" to compare.'}
                </span>
              ) : !diff.ok ? (
                <span>{'Could not read collection.'}</span>
              ) : inSync ? (
                <span className="text-success flex items-center gap-1">
                  <Check className="w-3 h-3" />{' '}
                  {Number(diff.inCollection.length) === 1
                    ? 'In sync — ' + String(diff.inCollection.length) + ' item'
                    : 'In sync — ' +
                      String(diff.inCollection.length) +
                      ' items'}
                </span>
              ) : (
                <span className="text-warning flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {String(driftCount) + ' to review'}
                </span>
              )}
            </div>
          </div>
          {diffCheckedAt && (
            <p className="text-[11px] text-muted-foreground/70">
              {'Last checked ' + String(diffCheckedAt.toLocaleTimeString('en'))}
              {diff?.title && (
                <>
                  {' '}
                  ·{' '}
                  <a
                    href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${collectionId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-foreground underline-offset-2 hover:underline"
                  >
                    {diff.title}
                  </a>
                </>
              )}
              {' · '}
              <span>
                {String(diff?.trackedCount ?? 0) + ' tracked locally'}
              </span>
            </p>
          )}
        </div>

        {diff?.ok && allItems.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border/40">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 p-0.5 text-xs">
                {(
                  [
                    ['missing', 'Missing from collection', missingCount],
                    ['not-on-server', 'Not on server', notOnServerCount],
                    ['tracked-only', 'Tracked only', trackedOnlyCount],
                    ['synced', 'In sync', syncedCount],
                    ['all', 'All', allItems.length],
                  ] as const
                )
                  .filter(
                    ([key, , count]) => key !== 'tracked-only' || count > 0,
                  )
                  .map(([key, label, count]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setItemFilter(key)}
                      className={cn(
                        'px-2 py-1 rounded-sm transition-colors',
                        itemFilter === key
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                      )}
                    >
                      {label} <span className="opacity-70">({count})</span>
                    </button>
                  ))}
              </div>

              <div className="relative ms-auto">
                <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder={'Filter by name or ID…'}
                  className="h-8 ps-7 pe-7 text-xs w-56"
                />
                {itemSearch && (
                  <button
                    type="button"
                    onClick={() => setItemSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={'Clear search'}
                  >
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-md border border-border/60 overflow-hidden">
              <div className="max-h-[420px] overflow-auto">
                {filteredItems.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {itemSearch
                      ? 'No mods match your search.'
                      : 'Nothing in this filter.'}
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                      <tr className="text-start text-muted-foreground border-b border-border/50">
                        <th className="font-medium px-3 py-2 sm:w-[120px]">
                          {'Status'}
                        </th>
                        <th className="font-medium px-3 py-2">{'Mod'}</th>
                        <th className="font-medium px-3 py-2 sm:w-[540px] text-end">
                          {'Actions'}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((it) => {
                        const busy = rowBusy[it.workshopId]
                        const statusMeta =
                          it.status === 'synced'
                            ? {
                                label: 'In sync',
                                cls: 'text-success border-success/40 bg-success/10',
                                icon: <Check className="w-3 h-3" />,
                              }
                            : it.status === 'to-add'
                              ? {
                                  label: 'Missing from collection',
                                  cls: 'text-warning border-warning/40 bg-warning/10',
                                  icon: <Plus className="w-3 h-3" />,
                                }
                              : it.status === 'collection-only'
                                ? {
                                    label: 'Not on server',
                                    cls: 'text-primary border-primary/40 bg-primary/10',
                                    icon: <Library className="w-3 h-3" />,
                                  }
                                : {
                                    label: 'Tracked only',
                                    cls: 'text-muted-foreground border-border bg-muted/40',
                                    icon: <AlertTriangle className="w-3 h-3" />,
                                  }
                        return (
                          <tr
                            key={it.workshopId}
                            className="border-b border-border/30 last:border-b-0 hover:bg-muted/30"
                          >
                            <td className="px-3 py-2 align-top">
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium',
                                  statusMeta.cls,
                                )}
                              >
                                {statusMeta.icon}
                                {statusMeta.label}
                              </span>
                            </td>
                            <td className="px-3 py-2 align-top">
                              <div className="flex flex-col min-w-0">
                                <a
                                  href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${it.workshopId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="truncate text-foreground hover:text-primary hover:underline underline-offset-2 font-medium"
                                  title={it.name || it.workshopId}
                                >
                                  {it.name || (
                                    <span className="font-mono text-muted-foreground">
                                      {it.workshopId}
                                    </span>
                                  )}
                                </a>
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/80 font-mono">
                                  <span>{it.workshopId}</span>
                                  <span className="hidden sm:inline">·</span>
                                  <span>
                                    {it.inTracked ? 'tracked' : 'not tracked'}
                                  </span>
                                  <span className="hidden sm:inline">·</span>
                                  <span>
                                    {it.inCollection
                                      ? 'in collection'
                                      : 'not in collection'}
                                  </span>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2 align-top">
                              <div className="flex items-center justify-end gap-1">
                                {it.inServer ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={() =>
                                      setRemoveServerTarget({
                                        workshopId: it.workshopId,
                                      })
                                    }
                                    disabled={!!busy}
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                    title={
                                      'Remove this mod from the server configuration'
                                    }
                                  >
                                    {busy === 'remove-server' ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Server className="w-3 h-3" />
                                    )}
                                    <span className="ms-1 hidden sm:inline">
                                      {'From server'}
                                    </span>
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
                                    onClick={() =>
                                      runRowAction(it.workshopId, 'add-server')
                                    }
                                    disabled={!!busy}
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                    title={
                                      'Add this mod to the server configuration'
                                    }
                                  >
                                    {busy === 'add-server' ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Server className="w-3 h-3" />
                                    )}
                                    <span className="ms-1 hidden sm:inline">
                                      {'To server'}
                                    </span>
                                  </Button>
                                )}
                                {it.inCollection ? (
                                  <DisabledReason
                                    reason={
                                      tokenExpired
                                        ? 'Steam session expired'
                                        : !credsConfigured
                                          ? 'Need Steam cookies'
                                          : null
                                    }
                                  >
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
                                      onClick={() =>
                                        runRowAction(it.workshopId, 'remove')
                                      }
                                      disabled={
                                        !!busy ||
                                        !credsConfigured ||
                                        tokenExpired
                                      }
                                      // eslint-disable-next-line local/no-dead-disabled-title -- This title describes the action, not why it is disabled.
                                      title={
                                        tokenExpired || !credsConfigured
                                          ? undefined
                                          : 'Remove from Steam collection'
                                      }
                                    >
                                      {busy === 'remove' ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Minus className="w-3 h-3" />
                                      )}
                                      <span className="ms-1 hidden sm:inline">
                                        {'From collection'}
                                      </span>
                                    </Button>
                                  </DisabledReason>
                                ) : (
                                  <DisabledReason
                                    reason={
                                      tokenExpired
                                        ? 'Steam session expired'
                                        : !credsConfigured
                                          ? 'Need Steam cookies'
                                          : null
                                    }
                                  >
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
                                      onClick={() =>
                                        runRowAction(it.workshopId, 'add')
                                      }
                                      disabled={
                                        !!busy ||
                                        !credsConfigured ||
                                        tokenExpired
                                      }
                                      // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27, same real bug and fix as the remove-from-collection button above.
                                      title={
                                        tokenExpired || !credsConfigured
                                          ? undefined
                                          : 'Add to Steam collection'
                                      }
                                    >
                                      {busy === 'add' ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Plus className="w-3 h-3" />
                                      )}
                                      <span className="ms-1 hidden sm:inline">
                                        {'To collection'}
                                      </span>
                                    </Button>
                                  </DisabledReason>
                                )}
                                {it.inTracked ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                    onClick={() =>
                                      runRowAction(it.workshopId, 'untrack')
                                    }
                                    disabled={!!busy}
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                    title={
                                      'Untrack locally (panel stops watching this mod)'
                                    }
                                  >
                                    {busy === 'untrack' ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Bookmark className="w-3 h-3" />
                                    )}
                                    <span className="ms-1 hidden sm:inline">
                                      {'Untrack'}
                                    </span>
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10"
                                    onClick={() =>
                                      runRowAction(it.workshopId, 'track')
                                    }
                                    disabled={!!busy}
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                    title={
                                      'Track locally (panel will watch this mod for updates)'
                                    }
                                  >
                                    {busy === 'track' ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <BookmarkPlus className="w-3 h-3" />
                                    )}
                                    <span className="ms-1 hidden sm:inline">
                                      {'Track'}
                                    </span>
                                  </Button>
                                )}
                                <span
                                  aria-hidden
                                  className="mx-1 h-4 w-px bg-border"
                                />
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                  onClick={() =>
                                    setPurgeTarget({
                                      workshopId: it.workshopId,
                                      name: it.name,
                                    })
                                  }
                                  disabled={!!busy}
                                  // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                  title={
                                    "Remove from the collection, the server, and disk, then ignore it so it can't come back"
                                  }
                                >
                                  {busy === 'purge' ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3 h-3" />
                                  )}
                                  <span className="ms-1 hidden sm:inline">
                                    {'Everywhere'}
                                  </span>
                                </Button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/40 bg-muted/20 text-[10px] text-muted-foreground">
                <span>
                  {String(filteredItems.length) +
                    ' of ' +
                    String(allItems.length) +
                    ' shown'}
                </span>
                <span className="hidden sm:inline">
                  {'Per-row actions apply immediately'}
                </span>
              </div>
            </div>
          </div>
        )}
        <AlertDialog
          open={!!purgeTarget}
          onOpenChange={(open) => !open && setPurgeTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {'Remove ' +
                  String(purgeTarget?.name || purgeTarget?.workshopId) +
                  ' everywhere?'}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>{'This removes the mod from all four places at once:'}</p>
                  <ul className="list-disc ps-5 space-y-0.5">
                    <li>{'the Steam collection'}</li>
                    <li>
                      <>
                        {'the server config ('}
                        <code>{'WorkshopItems'}</code>
                        {', '}
                        <code>{'Mods'}</code>
                        {', '}
                        <code>{'Map'}</code>
                        {')'}
                      </>
                    </li>
                    <li>{'the downloaded files on disk'}</li>
                    <li>{"the panel's tracked list"}</li>
                  </ul>
                  <p>
                    {
                      "It is then added to the ignore list so a later scan can't quietly bring it back. Restart the server to apply."
                    }
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  const target = purgeTarget
                  setPurgeTarget(null)
                  if (target)
                    runRowAction(target.workshopId, 'purge', target.name)
                }}
              >
                {'Remove everywhere'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={!!removeServerTarget}
          onOpenChange={(open) => !open && setRemoveServerTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {'Remove this mod from the server?'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {
                  "This removes it from the server's active mod list. It stays tracked here and can be re-added at any time."
                }
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  const target = removeServerTarget
                  setRemoveServerTarget(null)
                  if (target) runRowAction(target.workshopId, 'remove-server')
                }}
              >
                {'From server'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}
