import { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react'
import {
  Terminal as TerminalIcon,
  Send,
  Trash2,
  WifiOff,
  Loader2,
  Megaphone,
  FileText,
  RefreshCw,
  Pause,
  Play,
  Filter,
  ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  rconApi,
  configApi,
  serverApi,
  serversApi,
  ApiError,
  type ServerInstance,
} from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useAuth } from '@/contexts/AuthContext'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import { cn } from '@/lib/utils'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'

const RCON_EXECUTE_DISCONNECTED_CODE = 'RCON_EXECUTE_DISCONNECTED'
function isRconDisconnectError(code: string | undefined): boolean {
  return code === RCON_EXECUTE_DISCONNECTED_CODE
}

interface CommandEntry {
  id: number
  command: string
  response: string
  success: number
  executed_at: string
}

interface RconResponse {
  command: string
  response: string
  success: boolean
  timestamp: string
}

interface ParsedLogLine {
  type: 'LOG' | 'WARN' | 'ERROR' | 'DEBUG' | 'INFO' | 'UNKNOWN'
  category: string
  message: string
  raw: string
  time?: string
}

function formatLogTime(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs) || epochMs < 1_000_000_000_000) return undefined
  try {
    const d = new Date(epochMs)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  } catch {
    return undefined
  }
}

function parseLogLine(line: string): ParsedLogLine {
  const trimmed = line.trim()
  if (!trimmed) {
    return { type: 'UNKNOWN', category: '', message: '', raw: line }
  }

  const match = trimmed.match(
    /^(LOG|WARN|ERROR|DEBUG|INFO)\s*:\s*(\w+)(?:[^>]*?\bt:(\d+))?[^>]*>\s*(.+)$/i,
  )
  if (match) {
    let type = match[1].toUpperCase() as ParsedLogLine['type']
    const tField = match[3]
    const message = match[4]
    if (
      type === 'LOG' &&
      /^(java\.|kotlin\.|zombie\.|com\.|org\.|at\s+\S+\.|Exception in thread|Caused by:|\S+(Exception|Error)(:|\s|$))/i.test(
        message,
      )
    ) {
      type = 'ERROR'
    }
    return {
      type,
      category: match[2],
      message,
      raw: line,
      time: tField ? formatLogTime(Number(tField)) : undefined,
    }
  }

  if (trimmed.startsWith('ERROR')) {
    return {
      type: 'ERROR',
      category: '',
      message: trimmed.replace(/^ERROR\s*:?\s*/i, ''),
      raw: line,
    }
  }
  if (trimmed.startsWith('WARN')) {
    return {
      type: 'WARN',
      category: '',
      message: trimmed.replace(/^WARN\s*:?\s*/i, ''),
      raw: line,
    }
  }
  if (trimmed.startsWith('LOG')) {
    return {
      type: 'LOG',
      category: '',
      message: trimmed.replace(/^LOG\s*:?\s*/i, ''),
      raw: line,
    }
  }
  if (
    /^(\s*at\s+\S+|Caused by:|\.{3}\s+\d+ more|Exception in thread)/.test(
      trimmed,
    )
  ) {
    return { type: 'ERROR', category: '', message: trimmed, raw: line }
  }

  return { type: 'UNKNOWN', category: '', message: trimmed, raw: line }
}

const typeColors: Record<string, string> = {
  ERROR: 'text-destructive',
  WARN: 'text-warning',
  LOG: 'text-foreground/90',
  DEBUG: 'text-muted-foreground',
  INFO: 'text-primary',
  UNKNOWN: 'text-muted-foreground',
}

const typeBadgeColors: Record<string, string> = {
  ERROR: 'border border-destructive/25 bg-destructive/10 text-destructive',
  WARN: 'border border-warning/25 bg-warning/10 text-warning',
  LOG: 'border border-border/60 bg-muted/40 text-foreground/90',
  DEBUG: 'border border-border/50 bg-muted/25 text-muted-foreground',
  INFO: 'border border-primary/20 bg-primary/10 text-primary',
  UNKNOWN: 'border border-border/50 bg-muted/25 text-muted-foreground',
}

const chatChannelValues = [
  'all',
  'admin',
  'say',
  'faction',
  'safehouse',
] as const

function getChatChannels() {
  return chatChannelValues.map((value) => ({
    value,
    label:
      (
        {
          all: 'All players',
          admin: '[ADMIN] tag',
          say: '[SAY] tag',
          faction: '[FACTION] tag',
          safehouse: '[SAFEHOUSE] tag',
        } as Record<string, string>
      )[String(value)] ?? String(value),
    description:
      (
        {
          all: 'No tag — plain broadcast',
          admin: 'Marks the message as admin',
          say: 'Cosmetic local-chat label',
          faction: 'Cosmetic faction label',
          safehouse: 'Cosmetic safehouse label',
        } as Record<string, string>
      )[String(value)] ?? String(value),
  }))
}

const ServerLogLine = memo(function ServerLogLine({ line }: { line: string }) {
  const parsed = parseLogLine(line)
  if (!parsed.message && !parsed.raw.trim()) return null

  return (
    <div
      className={cn(
        'border-s px-2 py-0.5 leading-tight',
        parsed.type === 'ERROR'
          ? 'border-destructive/40 bg-destructive/8'
          : parsed.type === 'WARN'
            ? 'border-warning/40 bg-warning/8'
            : parsed.type === 'INFO'
              ? 'border-primary/20 bg-primary/5'
              : 'border-transparent',
      )}
    >
      <div className="flex items-baseline gap-1.5">
        {parsed.time && (
          <span className="shrink-0 text-muted-foreground/60 text-[11px] font-mono tabular-nums">
            {parsed.time}
          </span>
        )}
        {parsed.type !== 'UNKNOWN' && (
          <span
            className={`px-1 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0 ${typeBadgeColors[parsed.type]}`}
          >
            {parsed.type}
          </span>
        )}
        {parsed.category && (
          <span className="shrink-0 text-muted-foreground/70 text-[11px]">
            [{parsed.category}]
          </span>
        )}
        <span className={`${typeColors[parsed.type]} break-words min-w-0`}>
          {parsed.message || parsed.raw}
        </span>
      </div>
    </div>
  )
})

const quickCommandDefs = [
  { key: 'players', command: 'players' },
  { key: 'save', command: 'save' },
  { key: 'showOptions', command: 'showoptions' },
  { key: 'checkMods', command: 'checkModsNeedUpdate' },
  { key: 'help', command: 'help' },
  { key: 'serverInfo', command: 'serverinfo' },
  { key: 'getMemory', command: 'getmemory' },
] as const

function getQuickCommands() {
  return quickCommandDefs.map(({ key, command }) => ({
    label:
      (
        {
          players: 'Players',
          save: 'Save',
          showOptions: 'Show Options',
          checkMods: 'Check Mods',
          help: 'Help',
          serverInfo: 'Server Info',
          getMemory: 'Get Memory',
        } as Record<string, string>
      )[String(key)] ?? String(key),
    command,
  }))
}

const quickBroadcastKeys = [
  'restart15',
  'restart5',
  'restart1',
  'maintenance',
  'backOnline',
  'saveWarning',
] as const

function getQuickBroadcasts() {
  return quickBroadcastKeys.map((key) => ({
    label:
      (
        {
          restart15: 'Restart 15min',
          restart5: 'Restart 5min',
          restart1: 'Restart 1min',
          maintenance: 'Maintenance',
          backOnline: 'Back Online',
          saveWarning: 'Save Warning',
        } as Record<string, string>
      )[String(key)] ?? String(key),
    message:
      (
        {
          restart15:
            'SERVER RESTART in 15 minutes - Please find a safe location!',
          restart5: 'SERVER RESTART in 5 minutes - Save your progress!',
          restart1: 'SERVER RESTART in 1 minute - Disconnecting soon!',
          maintenance: 'Server entering MAINTENANCE MODE - Please disconnect',
          backOnline: 'Server maintenance complete - Welcome back!',
          saveWarning: 'Server is saving - Brief lag expected',
        } as Record<string, string>
      )[String(key)] ?? String(key),
  }))
}

const COMMAND_HISTORY_FETCH_LIMIT = 50

export default function Console() {
  const chatChannels = useMemo(() => getChatChannels(), [])
  const quickCommands = useMemo(() => getQuickCommands(), [])
  const quickBroadcasts = useMemo(() => getQuickBroadcasts(), [])
  const [command, setCommand] = useState('')
  const [activeServer, setActiveServer] = useState<ServerInstance | null>(null)
  const [consoleTargetLoading, setConsoleTargetLoading] = useState(true)
  const [history, setHistory] = useState<CommandEntry[]>([])
  const [liveLog, setLiveLog] = useState<RconResponse[]>([])
  const [loading, setLoading] = useState(false)
  const [commandHistoryIndex, setCommandHistoryIndex] = useState(-1)
  const [commandCache, setCommandCache] = useState<string[]>([])
  const [rconConnected, setRconConnected] = useState<boolean | null>(null)
  const [rconFailureReason, setRconFailureReason] = useState<
    'unreachable' | 'auth_failed' | 'dropped' | null
  >(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [selectedChannel, setSelectedChannel] = useState('all')
  const [sendingAnnouncement, setSendingAnnouncement] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [commandDraft, setCommandDraft] = useState('')
  const liveLogIdRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const socket = useSocket()
  const confirm = useConfirm()
  const { can } = useAuth()
  const canExecuteRcon = can('rcon.execute')

  const [serverLogLines, setServerLogLines] = useState<string[]>([])
  const [_serverLogSize, setServerLogSize] = useState(0)
  const [serverLogPath, setServerLogPath] = useState('')
  const [serverLogExists, setServerLogExists] = useState(false)
  const [serverLogLoading, setServerLogLoading] = useState(false)
  const [serverLogError, setServerLogError] = useState<string | null>(null)
  const serverLogErrorCountRef = useRef(0)
  const [serverLogAutoScroll, setServerLogAutoScroll] = useState(true)
  const [serverLogPaused, setServerLogPaused] = useState(false)
  const [serverLogFiltered, setServerLogFiltered] = useState(true)
  const [consoleTab, setConsoleTab] = useState('server-log')

  usePageShortcut('a', () => setServerLogAutoScroll((prev) => !prev))
  usePageShortcut('`', () =>
    setConsoleTab((prev) => (prev === 'server-log' ? 'rcon' : 'server-log')),
  )
  const serverLogRef = useRef<HTMLDivElement>(null)
  const serverLogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  )
  const serverLogSizeRef = useRef(0)
  const hasActiveServer = !!activeServer
  const hasServerLogSource =
    !!activeServer &&
    !activeServer.isRemote &&
    Boolean(activeServer.zomboidDataPath || activeServer.installPath)
  const hasRconConfig =
    !!activeServer &&
    Boolean(
      activeServer.rconHost &&
      activeServer.rconPort &&
      activeServer.rconPassword,
    )
  const serverLogUnavailable = !hasServerLogSource
    ? activeServer?.isRemote
      ? {
          title: 'Server log unavailable for remote servers',
          description:
            'Remote servers expose RCON only. Use the RCON tab for live commands.',
        }
      : {
          title: 'Server log path not configured',
          description:
            'Set the server install path or Zomboid data path in My Servers first.',
        }
    : null

  useEffect(() => {
    let cancelled = false

    const loadConsoleTarget = async () => {
      try {
        const data = await serversApi.getAll()
        if (cancelled) return

        const nextActiveServer =
          data.servers.find((server) => server.isActive) ??
          data.servers[0] ??
          null
        setActiveServer(nextActiveServer)
      } catch {
        if (!cancelled) {
          setActiveServer(null)
        }
      } finally {
        if (!cancelled) {
          setConsoleTargetLoading(false)
        }
      }
    }

    loadConsoleTarget()

    if (socket) socket.on('activeServerChanged', loadConsoleTarget)

    return () => {
      cancelled = true
      if (socket) socket.off('activeServerChanged', loadConsoleTarget)
    }
  }, [socket])

  const noisePatterns = useMemo(
    () => [
      /moveZombie: There are no zombies/i,
      /ItemPickInfo -> cannot get ID for container/i,
      /IsoThumpable not found on square/i,
      /SpriteConfig\.initObjectInfo.*Invalid SpriteConfig/i,
      /MOWoodenWalFrame\.lua: replacing isoObject/i,
      /OreVein\{startPoint/i,
      /SkeletonBone not resolved for bone/i,
      /action was null, object: null/i,
      /Could not find item type for/i,
      /Canceled loading wrong transition/i,
    ],
    [],
  )

  const filteredLogLines = useMemo(() => {
    if (!serverLogFiltered) return serverLogLines
    return serverLogLines.filter(
      (line) => !noisePatterns.some((pattern) => pattern.test(line)),
    )
  }, [serverLogLines, serverLogFiltered, noisePatterns])

  const fetchHistory = useCallback(async () => {
    if (!hasActiveServer) {
      setHistory([])
      setCommandCache([])
      return
    }

    try {
      const data = await rconApi.getHistory(COMMAND_HISTORY_FETCH_LIMIT)
      setHistory(data.history || [])
      setCommandCache(
        data.history?.map((h: CommandEntry) => h.command).reverse() || [],
      )
    } catch {
      toast({
        title: 'History Unavailable',
        description: 'Recent RCON command history could not be loaded.',
        variant: 'destructive',
      })
    }
  }, [hasActiveServer, toast])

  const testRconConnection = useCallback(async () => {
    if (!hasRconConfig) {
      setRconConnected(null)
      setRconFailureReason(null)
      setTestingConnection(false)
      return
    }

    setTestingConnection(true)
    try {
      const result = await configApi.testRcon()
      setRconConnected(result.success && result.connected)
      setRconFailureReason(null)
    } catch (err) {
      setRconConnected(false)
      const data =
        err instanceof ApiError
          ? (err.data as { error?: string } | undefined)
          : undefined
      setRconFailureReason(
        data?.error === 'auth_failed' ? 'auth_failed' : 'unreachable',
      )
    } finally {
      setTestingConnection(false)
    }
  }, [hasRconConfig])

  const fetchServerLog = useCallback(
    async (initial = false) => {
      if (!hasServerLogSource) {
        if (initial) {
          setServerLogLines([])
          setServerLogSize(0)
          setServerLogPath('')
          setServerLogExists(false)
          setServerLogError(null)
          serverLogErrorCountRef.current = 0
          serverLogSizeRef.current = 0
        }
        setServerLogLoading(false)
        return
      }

      if (serverLogPausedRef.current && !initial) return

      try {
        if (initial) {
          setServerLogLoading(true)
          setServerLogError(null)
          serverLogErrorCountRef.current = 0
          const data = await serverApi.getConsoleLog(1000)
          setServerLogLines(data.lines || [])
          setServerLogSize(data.size || 0)
          serverLogSizeRef.current = data.size || 0
          setServerLogPath(data.path || '')
          setServerLogExists(data.exists || false)
        } else {
          const data = await serverApi.streamConsoleLog(
            serverLogSizeRef.current,
          )
          if (data.newLines && data.newLines.length > 0) {
            setServerLogLines((prev) => [...prev, ...data.newLines].slice(-500))
          }
          if (data.rotated) {
            setServerLogLines(data.newLines || [])
          }
          setServerLogSize(data.currentSize || serverLogSizeRef.current)
          serverLogSizeRef.current =
            data.currentSize || serverLogSizeRef.current
          if (serverLogErrorCountRef.current > 0) {
            serverLogErrorCountRef.current = 0
            setServerLogError(null)
          }
        }
      } catch {
        serverLogErrorCountRef.current += 1
        if (serverLogErrorCountRef.current >= 3) {
          setServerLogError('Log stream unavailable — server may be offline')
        }
      } finally {
        setServerLogLoading(false)
      }
    },
    [hasServerLogSource],
  )

  const clearServerLog = async () => {
    const confirmed = await confirm({
      title: 'Erase the server console log?',
      description:
        'This permanently erases server-console.txt on disk, not just this display. There is no undo.',
      confirmLabel: 'Erase log file',
    })
    if (!confirmed) return

    try {
      await serverApi.clearConsoleLog()
      setServerLogLines([])
      setServerLogSize(0)
      toast({
        title: 'Log Cleared',
        description: 'Server console log has been cleared',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to clear server log'),
        variant: 'destructive',
      })
    }
  }

  const serverLogPausedRef = useRef(serverLogPaused)
  useEffect(() => {
    serverLogPausedRef.current = serverLogPaused
  }, [serverLogPaused])

  useEffect(() => {
    if (!hasServerLogSource) {
      if (serverLogIntervalRef.current) {
        clearInterval(serverLogIntervalRef.current)
        serverLogIntervalRef.current = null
      }
      return undefined
    }

    fetchServerLog(true)

    serverLogIntervalRef.current = setInterval(() => {
      if (
        !serverLogPausedRef.current &&
        document.visibilityState !== 'hidden'
      ) {
        fetchServerLog(false)
      }
    }, 2000)

    return () => {
      if (serverLogIntervalRef.current) {
        clearInterval(serverLogIntervalRef.current)
        serverLogIntervalRef.current = null
      }
    }
  }, [fetchServerLog, hasServerLogSource])

  useEffect(() => {
    if (serverLogAutoScroll && serverLogRef.current) {
      const el = serverLogRef.current
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    }
  }, [serverLogLines, serverLogAutoScroll])

  useEffect(() => {
    if (!hasActiveServer) return

    fetchHistory()
    if (hasRconConfig) {
      testRconConnection()
    } else {
      setRconConnected(null)
      setRconFailureReason(null)
    }
    inputRef.current?.focus()
  }, [fetchHistory, hasActiveServer, hasRconConfig, testRconConnection])

  useEffect(() => {
    if (socket) {
      const handleRconResponse = (data: RconResponse) => {
        const entry = {
          ...data,
          _id: ++liveLogIdRef.current,
        } as RconResponse & { _id: number }
        setLiveLog((prev) => [...prev, entry].slice(-100))
        if (data.success) {
          setRconConnected(true)
          setRconFailureReason(null)
        }
      }

      socket.on('rcon:response', handleRconResponse)

      const subscribeRcon = () => socket.emit('subscribe:rcon')
      if (canExecuteRcon) {
        if (socket.connected) subscribeRcon()
        socket.on('connect', subscribeRcon)
      }

      return () => {
        socket.off('rcon:response', handleRconResponse)
        socket.off('connect', subscribeRcon)
      }
    }
  }, [socket, canExecuteRcon])

  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    }
  }, [liveLog])

  const executeCommand = async () => {
    if (!command.trim()) return
    if (!canExecuteRcon) return

    setLoading(true)
    try {
      let result: {
        success: boolean
        response?: string
        error?: string
        code?: string
      }
      try {
        result = await rconApi.execute(command)
      } catch (error) {
        result = {
          success: false,
          error: getUserErrorMessage(error, 'Command failed'),
          code: error instanceof ApiError ? error.code : undefined,
        }
      }

      if (isRconDisconnectError(result.code)) {
        setRconConnected(false)
        setRconFailureReason('dropped')
      } else if (result.success) {
        setRconConnected(true)
        setRconFailureReason(null)
      }

      if (!result.success) {
        toast({
          title: 'Error',
          description: result.error || 'Command failed',
          variant: 'destructive',
        })
      }

      setCommandCache((prev) => [...prev.slice(-99), command])
      setCommandHistoryIndex(-1)
      setCommand('')

      inputRef.current?.focus()

      fetchHistory()
    } catch (error) {
      setRconConnected(false)
      setRconFailureReason(null)
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Command failed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      executeCommand()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (commandCache.length > 0) {
        if (commandHistoryIndex === -1) setCommandDraft(command)
        const newIndex =
          commandHistoryIndex < commandCache.length - 1
            ? commandHistoryIndex + 1
            : commandHistoryIndex
        setCommandHistoryIndex(newIndex)
        setCommand(commandCache[commandCache.length - 1 - newIndex] || '')
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (commandHistoryIndex > 0) {
        const newIndex = commandHistoryIndex - 1
        setCommandHistoryIndex(newIndex)
        setCommand(commandCache[commandCache.length - 1 - newIndex] || '')
      } else if (commandHistoryIndex === 0) {
        setCommandHistoryIndex(-1)
        setCommand(commandDraft)
        setCommandDraft('')
      }
    }
  }

  const clearLog = () => {
    setLiveLog([])
  }

  const sendAnnouncement = async () => {
    if (!announcement.trim()) return
    if (!canExecuteRcon) return

    setSendingAnnouncement(true)
    try {
      const cleaned = Array.from(announcement.replace(/["\\]/g, ''))
        .filter((character) => {
          const code = character.charCodeAt(0)
          return code >= 0x20 && code !== 0x7f
        })
        .join('')
      const cmd =
        selectedChannel === 'all'
          ? `servermsg "${cleaned}"`
          : `servermsg "[${selectedChannel.toUpperCase()}] ${cleaned}"`
      let result: {
        success: boolean
        response?: string
        error?: string
        code?: string
      }
      try {
        result = await rconApi.execute(cmd)
      } catch (error) {
        result = {
          success: false,
          error: getUserErrorMessage(error, 'Failed to send broadcast'),
          code: error instanceof ApiError ? error.code : undefined,
        }
      }

      if (result.success) {
        toast({
          title: 'Broadcast Sent',
          description:
            selectedChannel === 'all'
              ? 'Your message was broadcast to all players'
              : 'Sent with the [' +
                String(selectedChannel.toUpperCase()) +
                '] tag',
          variant: 'success' as const,
        })
        setAnnouncement('')
        setRconConnected(true)
        setRconFailureReason(null)
      } else {
        if (isRconDisconnectError(result.code)) {
          setRconConnected(false)
          setRconFailureReason(null)
        }
        toast({
          title: 'Error',
          description: result.error || 'Failed to send broadcast',
          variant: 'destructive',
        })
      }
    } catch (error) {
      const message = getUserErrorMessage(error, 'Failed to send broadcast')
      if (
        isRconDisconnectError(
          error instanceof ApiError ? error.code : undefined,
        )
      ) {
        setRconConnected(false)
        setRconFailureReason(null)
      }
      toast({
        title: 'Error',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setSendingAnnouncement(false)
    }
  }

  if (consoleTargetLoading) {
    return (
      <div className="space-y-6 page-transition">
        <PageHeader
          title={'Console'}
          description={'Server log output and RCON commands'}
          tone="ops"
          icon={<TerminalIcon className="w-5 h-5" />}
        />
        <div className="flex min-h-[18rem] items-center justify-center rounded-md border border-border/50 bg-card/50">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            {'checking server target'}
          </div>
        </div>
      </div>
    )
  }

  if (!hasActiveServer) {
    return (
      <div className="space-y-6 page-transition">
        <PageHeader
          title={'Console'}
          description={'Server log output and RCON commands'}
          tone="ops"
          icon={<TerminalIcon className="w-5 h-5" />}
        />
        <div className="rounded-md border border-border/50 bg-card/50 p-4">
          <EmptyState
            type="empty"
            title={'No active server configured'}
            description={
              'Add or select a server in My Servers before opening the console.'
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={'Console'}
        description={'Server log output and RCON commands'}
        tone="ops"
        icon={<TerminalIcon className="w-5 h-5" />}
      />
      <Tabs value={consoleTab} onValueChange={setConsoleTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 bg-muted/30 border border-border/50 rounded-md p-0.5">
          <TabsTrigger
            value="server-log"
            className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none rounded-sm"
          >
            <FileText className="w-3.5 h-3.5" />
            {'server log'}
          </TabsTrigger>
          <TabsTrigger
            value="rcon"
            className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none rounded-sm"
          >
            <TerminalIcon className="w-3.5 h-3.5" />
            {'rcon console'}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="server-log" className="space-y-3 mt-4">
          {serverLogUnavailable ? (
            <div className="flex h-[calc(100vh-360px)] min-h-[300px] items-center justify-center rounded-md border border-border/50 bg-muted/20 p-4">
              <EmptyState
                type="noFile"
                title={serverLogUnavailable.title}
                description={serverLogUnavailable.description}
                compact
              />
            </div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2 rounded-md border border-border/50 bg-card/70 backdrop-blur-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 shrink-0">
                    {'path'}
                  </span>
                  <p
                    className="text-xs text-foreground/80 font-mono truncate"
                    title={serverLogPath || undefined}
                  >
                    {serverLogPath ? (
                      serverLogPath
                    ) : (
                      <span className="text-muted-foreground/50">
                        {'loading…'}
                      </span>
                    )}
                  </p>
                  {serverLogLoading && (
                    <Loader2 className="w-3 h-3 animate-spin text-primary/70 shrink-0" />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]"
                    onClick={() => setServerLogPaused(!serverLogPaused)}
                    aria-label={
                      serverLogPaused
                        ? 'Resume auto-update'
                        : 'Pause auto-update'
                    }
                  >
                    {serverLogPaused ? (
                      <>
                        <Play className="w-3 h-3 me-1" />
                        {'resume'}
                      </>
                    ) : (
                      <>
                        <Pause className="w-3 h-3 me-1" />
                        {'pause'}
                      </>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setServerLogFiltered(!serverLogFiltered)}
                    aria-label={
                      serverLogFiltered
                        ? 'Show all messages (including noise)'
                        : 'Filter out repetitive messages'
                    }
                    title={
                      serverLogFiltered
                        ? Number(
                            Math.max(
                              0,
                              serverLogLines.length - filteredLogLines.length,
                            ),
                          ) === 1
                          ? 'Hiding ' +
                            String(
                              Math.max(
                                0,
                                serverLogLines.length - filteredLogLines.length,
                              ),
                            ) +
                            ' repetitive line — click to show all'
                          : 'Hiding ' +
                            String(
                              Math.max(
                                0,
                                serverLogLines.length - filteredLogLines.length,
                              ),
                            ) +
                            ' repetitive lines — click to show all'
                        : 'Filter out repetitive messages (joins, idle ticks, etc.)'
                    }
                    className={cn(
                      'h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]',
                      serverLogFiltered && 'text-primary',
                    )}
                  >
                    <Filter className="w-3 h-3 me-1" />
                    {serverLogFiltered
                      ? serverLogLines.length > filteredLogLines.length
                        ? 'filter −' +
                          String(
                            serverLogLines.length - filteredLogLines.length,
                          )
                        : 'filter'
                      : 'all'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setServerLogAutoScroll(!serverLogAutoScroll)}
                    aria-label={
                      serverLogAutoScroll
                        ? 'Disable auto-scroll'
                        : 'Enable auto-scroll'
                    }
                    title={
                      serverLogAutoScroll
                        ? 'Auto-scroll is ON — follows newest line'
                        : 'Auto-scroll is OFF — click to follow newest line'
                    }
                    className={cn(
                      'h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]',
                      serverLogAutoScroll
                        ? 'text-primary'
                        : 'text-muted-foreground',
                    )}
                  >
                    {serverLogAutoScroll ? 'follow on' : 'follow off'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => fetchServerLog(true)}
                    aria-label={'Refresh log'}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]"
                        onClick={clearServerLog}
                      >
                        <Trash2 className="w-3 h-3 me-1" />
                        {'clear'}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {
                        "Erase the server's console log file — this cannot be undone"
                      }
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>

              {serverLogError && (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-destructive"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                  <span className="flex-1">// {serverLogError}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]"
                    onClick={() => fetchServerLog(true)}
                  >
                    {'retry'}
                  </Button>
                </div>
              )}

              {!serverLogExists ? (
                <div className="flex h-[calc(100vh-360px)] min-h-[300px] items-center justify-center rounded-md border border-border/50 bg-muted/20 p-4">
                  <EmptyState
                    type="serverOffline"
                    title={'Server console log not found'}
                    description={'Make sure the server is running'}
                    compact
                  />
                </div>
              ) : (
                <div className="relative rounded-md border border-border/55 bg-card/85 overflow-hidden shadow-lg">
                  <div
                    aria-hidden
                    className="absolute top-1 left-1 w-2.5 h-2.5 border-s-2 border-t-2 border-primary/45 pointer-events-none z-10"
                  />
                  <div
                    aria-hidden
                    className="absolute top-1 right-1 w-2.5 h-2.5 border-e-2 border-t-2 border-primary/45 pointer-events-none z-10"
                  />
                  <div
                    aria-hidden
                    className="absolute bottom-1 left-1 w-2.5 h-2.5 border-s-2 border-b-2 border-primary/45 pointer-events-none z-10"
                  />
                  <div
                    aria-hidden
                    className="absolute bottom-1 right-1 w-2.5 h-2.5 border-e-2 border-b-2 border-primary/45 pointer-events-none z-10"
                  />
                  <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
                    <span className="flex items-center gap-1.5 text-primary/65">
                      <span>{'stream'}</span>
                      <span className="text-muted-foreground/40 normal-case tracking-normal">
                        ·
                      </span>
                      <span className="text-muted-foreground/80 normal-case tracking-normal">
                        {serverLogPaused ? 'paused' : 'live'}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 text-muted-foreground/60">
                      <span
                        className={cn(
                          'w-1.5 h-1.5 rounded-full',
                          serverLogPaused
                            ? 'bg-amber-400/70'
                            : 'bg-emerald-400/80 animate-pulse',
                        )}
                      />
                      <span>{serverLogPaused ? 'paused' : 'streaming'}</span>
                    </span>
                  </div>
                  <div
                    ref={serverLogRef}
                    role="log"
                    aria-live="polite"
                    aria-label={'Server console output'}
                    className="h-[calc(100vh-400px)] min-h-[280px] overflow-auto bg-background/60 p-3 font-mono text-xs terminal-output"
                  >
                    {filteredLogLines.length === 0 ? (
                      <div className="p-2 font-mono text-[11px] text-muted-foreground/70">
                        {serverLogFiltered && serverLogLines.length > 0 ? (
                          <span>
                            {Number(serverLogLines.length) === 1
                              ? String(serverLogLines.length) +
                                ' line hidden by filter · '
                              : String(serverLogLines.length) +
                                ' lines hidden by filter · '}
                            <button
                              type="button"
                              className="underline underline-offset-2 text-primary/80 hover:text-primary"
                              onClick={() => setServerLogFiltered(false)}
                            >
                              {'show all'}
                            </button>
                          </span>
                        ) : serverLogError ? (
                          <span>
                            {
                              'Log output unknown — the stream is down, see the error above.'
                            }
                          </span>
                        ) : (
                          <span>
                            {
                              "No log output yet — the server hasn't written anything since this view opened."
                            }
                          </span>
                        )}
                      </div>
                    ) : (
                      filteredLogLines.map((line, index) => (
                        <ServerLogLine key={index} line={line} />
                      ))
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-border/50 bg-muted/20 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70 select-none">
                    <span className="tabular-nums">
                      {serverLogFiltered ? (
                        <>
                          {'shown'}{' '}
                          <span className="text-foreground/80">
                            {filteredLogLines.length}
                          </span>{' '}
                          · {'hidden'}{' '}
                          <span className="text-muted-foreground/50">
                            {serverLogLines.length - filteredLogLines.length}
                          </span>
                        </>
                      ) : (
                        <>
                          {'loaded'}{' '}
                          <span className="text-foreground/80">
                            {serverLogLines.length}
                          </span>
                        </>
                      )}
                    </span>
                    <span>
                      {serverLogPaused ? 'updates suspended' : 'poll · 2s'}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="rcon" className="space-y-3 mt-4">
          <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-border/50 bg-card/70 backdrop-blur-sm">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 shrink-0">
                {'link'}
              </span>
              {testingConnection ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {'checking…'}
                </span>
              ) : !hasRconConfig ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-warning">
                  <WifiOff className="w-3 h-3" />
                  {'rcon not configured'}
                </span>
              ) : rconConnected === null ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                  {'unknown'}
                </span>
              ) : rconConnected ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {'rcon online'}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-destructive">
                  <WifiOff className="w-3 h-3" />
                  {'rcon offline'}
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em]"
              onClick={testRconConnection}
              disabled={testingConnection || !hasRconConfig}
            >
              <RefreshCw
                className={cn(
                  'w-3 h-3 me-1',
                  testingConnection && 'animate-spin',
                )}
              />
              {'recheck'}
            </Button>
          </div>

          {!hasRconConfig && (
            <div
              role="status"
              className="flex items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2"
            >
              <WifiOff className="w-4 h-4 shrink-0 text-warning" />
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-warning">
                  {'rcon not configured'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {
                    'Set the host, port, and password in My Servers before using live commands.'
                  }
                </p>
              </div>
            </div>
          )}

          {hasRconConfig && rconConnected === false && (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2"
            >
              <WifiOff className="w-4 h-4 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-destructive">
                  {rconFailureReason === 'auth_failed'
                    ? 'authentication failed'
                    : rconFailureReason === 'dropped'
                      ? 'connection dropped'
                      : 'host unreachable'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {rconFailureReason === 'auth_failed'
                    ? 'The host is reachable — confirm the RCON password on My Servers.'
                    : rconFailureReason === 'dropped'
                      ? "RCON disconnected while running a command. Host, port, and password were just confirmed correct -- select Recheck above once you believe it's back."
                      : 'Start the server, then confirm RCON host, port, and password in Panel Settings.'}
                </p>
              </div>
            </div>
          )}

          <div className="relative rounded-md border border-border/55 bg-card/85 overflow-hidden shadow-lg">
            <div
              aria-hidden
              className="absolute top-1 left-1 w-2.5 h-2.5 border-s-2 border-t-2 border-primary/45 pointer-events-none z-10"
            />
            <div
              aria-hidden
              className="absolute top-1 right-1 w-2.5 h-2.5 border-e-2 border-t-2 border-primary/45 pointer-events-none z-10"
            />
            <div
              aria-hidden
              className="absolute bottom-1 left-1 w-2.5 h-2.5 border-s-2 border-b-2 border-primary/45 pointer-events-none z-10"
            />
            <div
              aria-hidden
              className="absolute bottom-1 right-1 w-2.5 h-2.5 border-e-2 border-b-2 border-primary/45 pointer-events-none z-10"
            />
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
              <span className="flex items-center gap-1.5 text-primary/65">
                <span>{'rcon output'}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">
                  ·
                </span>
                <span className="text-muted-foreground/80 normal-case tracking-normal tabular-nums">
                  {Number(liveLog.length) === 1
                    ? String(liveLog.length) + ' entry'
                    : String(liveLog.length) + ' entries'}
                </span>
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 -my-1 font-mono text-[10px] uppercase tracking-[0.16em]"
                    onClick={clearLog}
                    disabled={liveLog.length === 0}
                  >
                    <Trash2 className="w-3 h-3 me-1" />
                    {'clear'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {'Clear the visible output (does not delete history)'}
                </TooltipContent>
              </Tooltip>
            </div>
            <div
              ref={scrollRef}
              role="log"
              aria-live="polite"
              aria-label={'RCON command output'}
              className="h-[18rem] min-h-[220px] sm:h-[22rem] lg:h-[26rem] overflow-auto bg-background/60 p-3 terminal-output"
            >
              {liveLog.length === 0 ? (
                <EmptyState
                  compact
                  type="noMessages"
                  title={'No commands yet'}
                  description={'Run an RCON command to see the response here.'}
                />
              ) : (
                liveLog.map((entry, idx) => (
                  <div
                    key={
                      (entry as RconResponse & { _id?: number })._id ??
                      `${entry.timestamp}-${idx}`
                    }
                    className="mb-3 font-mono text-sm"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-primary shrink-0">$</span>
                      <span className="text-foreground/90 break-all min-w-0 grow">
                        {entry.command}
                      </span>
                      <span className="text-muted-foreground/60 text-[10px] ms-auto shrink-0 tabular-nums font-mono">
                        {new Date(entry.timestamp).toLocaleTimeString('en')}
                      </span>
                    </div>
                    <div
                      className={cn(
                        'ms-4 mt-0.5 text-xs border-s-2 ps-2 break-words',
                        entry.success
                          ? 'border-primary/30 text-foreground/85'
                          : 'border-destructive/50 text-destructive',
                      )}
                    >
                      {entry.response.split('\n').map((line, i) => (
                        <div key={`line-${i}`} className="break-words">
                          {line || '\u00A0'}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 me-1">
              {'quick'}
            </span>
            {quickCommands.map((qc) => (
              <Button
                key={qc.command}
                variant="outline"
                size="sm"
                className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em] border-border/55 hover:border-primary/55"
                onClick={() => {
                  setCommand(qc.command)
                  inputRef.current?.focus()
                }}
                disabled={!hasRconConfig || rconConnected === false}
              >
                {qc.label}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60">
              {'command'}
            </span>
            <HelpTip label={'command'}>
              {
                "Commands here run immediately against the live server, with no confirmation step -- even for something that stops the server or removes a player. If you're not sure what a command does, check it before running it; most have no undo."
              }
            </HelpTip>
          </div>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <span
                className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[11px] uppercase tracking-[0.18em] text-primary/70 pointer-events-none select-none"
                aria-hidden="true"
              >
                {'rcon $'}
              </span>
              <Input
                ref={inputRef}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={'type a command…'}
                className="ps-[5.5rem] font-mono bg-card/70 border-border/55 focus-visible:border-primary/60"
                disabled={
                  loading ||
                  !hasRconConfig ||
                  rconConnected === false ||
                  !canExecuteRcon
                }
                maxLength={2000}
                aria-label={'RCON command input'}
              />
            </div>
            <DisabledReason
              reason={
                !canExecuteRcon
                  ? "Your role doesn't have permission to run RCON commands."
                  : rconConnected === false
                    ? 'RCON is currently unreachable -- select Recheck above before trying again.'
                    : null
              }
            >
              <Button
                onClick={executeCommand}
                disabled={
                  loading ||
                  !command.trim() ||
                  !hasRconConfig ||
                  rconConnected === false ||
                  !canExecuteRcon
                }
                aria-label={'Execute command'}
                className="font-mono text-[11px] uppercase tracking-[0.18em]"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5 me-1.5" />
                    {'run'}
                  </>
                )}
              </Button>
            </DisabledReason>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
            {'// enter · run · ↑↓ history'}
          </p>

          <div className="rounded-md border border-border/55 bg-card/70 backdrop-blur-sm overflow-hidden">
            <button
              type="button"
              onClick={() => setShowBroadcast((v) => !v)}
              aria-expanded={showBroadcast}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.22em] hover:bg-muted/40 transition-colors"
            >
              <span className="flex items-center gap-1.5 text-primary/70">
                <Megaphone className="w-3 h-3" />
                <span>{'broadcast'}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">
                  ·
                </span>
                <span className="text-muted-foreground/70 normal-case tracking-normal">
                  {'message all online'}
                </span>
              </span>
              <ChevronDown
                className={cn(
                  'w-3.5 h-3.5 text-muted-foreground transition-transform',
                  showBroadcast && 'rotate-180',
                )}
              />
            </button>
            {showBroadcast && (
              <div className="border-t border-border/40 p-4 space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {quickBroadcasts.map((qb) => (
                    <Button
                      key={qb.label}
                      variant="outline"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setAnnouncement(qb.message)}
                      disabled={!hasRconConfig || rconConnected === false}
                    >
                      {qb.label}
                    </Button>
                  ))}
                </div>

                <div className="grid gap-2 sm:grid-cols-[180px_1fr] sm:items-start">
                  <Select
                    value={selectedChannel}
                    onValueChange={setSelectedChannel}
                  >
                    <SelectTrigger aria-label={'Channel tag'}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {chatChannels.map((channel) => (
                        <SelectItem key={channel.value} value={channel.value}>
                          <div className="flex flex-col">
                            <span>{channel.label}</span>
                            <span className="text-xs text-muted-foreground">
                              {channel.description}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Textarea
                    value={announcement}
                    onChange={(e) => setAnnouncement(e.target.value)}
                    placeholder={
                      selectedChannel === 'all'
                        ? 'Write the message players should see…'
                        : 'Tagged [' +
                          String(selectedChannel.toUpperCase()) +
                          '] — write the message…'
                    }
                    aria-label={'Broadcast message'}
                    className="min-h-[80px]"
                    maxLength={500}
                    disabled={
                      sendingAnnouncement ||
                      !hasRconConfig ||
                      rconConnected === false
                    }
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    <>
                      {'Sends via '}
                      <code className="text-foreground/80">{'servermsg'}</code>
                      {
                        '. Tags are cosmetic — RCON cannot route to real chat channels.'
                      }
                    </>
                  </p>
                  <DisabledReason
                    reason={
                      !canExecuteRcon
                        ? "Your role doesn't have permission to run RCON commands."
                        : null
                    }
                  >
                    <Button
                      onClick={sendAnnouncement}
                      disabled={
                        sendingAnnouncement ||
                        !announcement.trim() ||
                        !hasRconConfig ||
                        rconConnected === false ||
                        !canExecuteRcon
                      }
                    >
                      {sendingAnnouncement ? (
                        <Loader2 className="w-4 h-4 animate-spin me-2" />
                      ) : (
                        <Send className="w-4 h-4 me-2" />
                      )}
                      {'Send'}
                    </Button>
                  </DisabledReason>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-md border border-border/55 bg-card/70 backdrop-blur-sm overflow-hidden">
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              aria-expanded={showHistory}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.22em] hover:bg-muted/40 transition-colors"
            >
              <span className="flex items-center gap-1.5 text-primary/70">
                <FileText className="w-3 h-3" />
                <span>{'history'}</span>
                {history.length > 0 && (
                  <>
                    <span className="text-muted-foreground/40 normal-case tracking-normal">
                      ·
                    </span>
                    <span className="text-muted-foreground/70 normal-case tracking-normal tabular-nums">
                      {Number(history.length) === 1
                        ? String(history.length) + ' entry'
                        : String(history.length) + ' entries'}
                    </span>
                    {history.length >= COMMAND_HISTORY_FETCH_LIMIT && (
                      <span className="text-muted-foreground/50 normal-case tracking-normal">
                        {'(most recent -- older commands may not be shown)'}
                      </span>
                    )}
                  </>
                )}
              </span>
              <ChevronDown
                className={cn(
                  'w-3.5 h-3.5 text-muted-foreground transition-transform',
                  showHistory && 'rotate-180',
                )}
              />
            </button>
            {showHistory && (
              <div className="border-t border-border/40 p-3 space-y-2">
                <div className="relative">
                  <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder={'Search command history...'}
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    className="ps-8 h-8 text-sm"
                    aria-label={'Search command history'}
                  />
                </div>
                <ScrollArea className="h-[16rem] min-h-[200px] sm:h-[20rem] rounded-lg border border-border/30 bg-background/40">
                  {history.length === 0 ? (
                    <EmptyState
                      compact
                      type="noData"
                      title={'No command history'}
                      description={'Commands you run will be logged here.'}
                    />
                  ) : (
                    <div className="space-y-1 p-2">
                      {history
                        .filter(
                          (entry) =>
                            !historySearch ||
                            entry.command
                              .toLowerCase()
                              .includes(historySearch.toLowerCase()) ||
                            entry.response
                              ?.toLowerCase()
                              .includes(historySearch.toLowerCase()),
                        )
                        .map((entry) => (
                          <button
                            key={entry.id}
                            type="button"
                            className="w-full text-start p-2.5 rounded-md hover:bg-muted/30 cursor-pointer transition-colors"
                            onClick={() => {
                              setCommand(entry.command)
                              inputRef.current?.focus()
                            }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <code className="text-sm font-mono text-primary truncate min-w-0 flex-1">
                                {entry.command}
                              </code>
                              <span className="text-xs text-muted-foreground shrink-0">
                                {new Date(entry.executed_at).toLocaleString(
                                  'en',
                                )}
                              </span>
                            </div>
                            {entry.response && (
                              <p
                                className={cn(
                                  'mt-1 truncate text-xs font-mono',
                                  entry.success
                                    ? 'text-muted-foreground'
                                    : 'text-destructive',
                                )}
                              >
                                {entry.response}
                              </p>
                            )}
                          </button>
                        ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
