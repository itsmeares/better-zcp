import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { DisabledReason } from '@/components/DisabledReason'
import { usePageShortcut } from '../hooks/useKeyboardShortcuts'
import { copyText } from '@/lib/utils'
import {
  Package,
  RefreshCw,
  Plus,
  Trash2,
  ExternalLink,
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  Clock,
  Download,
  FileText,
  Map as MapIcon,
  Library,
  Search,
  Filter,
  Settings2,
  ChevronRight,
  Check,
  Info,
  Layers,
  Save,
  FolderOpen,
  Loader2,
  GripVertical,
  MoreVertical,
  Wrench,
  PlusCircle,
  X,
  EyeOff,
  Eye,
  ArrowRight,
  Wand2,
  ShieldAlert,
  CloudOff,
} from 'lucide-react'
import {
  ConflictScanResult,
  ScanStreamModScanned,
  ScanStreamConflictFound,
} from '@/types'
import { WorkshopCollectionPanel } from '@/components/WorkshopCollectionPanel'
import { ConflictsPanel } from '@/components/mods/ConflictsPanel'
import {
  ModRow,
  WorkshopIdChip,
  WorkshopLinkAction,
  WorkshopThumb,
} from '@/components/mods/ModRow'
import {
  useLocalStorageState,
  type TrackedMod,
  type ModStatus,
  type ModEntry,
  type WsGroup,
  type DepSearchHit,
  type DepSearchState,
} from '@/lib/modsShared'
import { getAccessToken } from '@/lib/authToken'
import { isDemoMode } from '@/lib/demo'
import {
  createConflictScanSnapshot,
  recalculateConflictWinners,
} from '@/lib/conflictSeverity'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NumberInput } from '@/components/NumberInput'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { reportClientError, reportClientWarning } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { modsApi, serversApi, ApiError } from '@/lib/api'
import { FolderBrowser } from '@/components/FolderBrowser'
import {
  buildRequiresMap,
  computeAutoSortedOrder,
  createRequirementResolver,
  type AutoSortResult,
} from '@/lib/modLoadOrder'
import { EmptyState } from '@/components/EmptyState'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface CollectionMod {
  workshopId: string
  name: string
  description?: string
  tags?: string[]
  isMap: boolean
  modId?: string
  mapFolder?: string
  selected?: boolean
}

interface IniConfig {
  configured: boolean
  modIds: string[]
  workshopIds: string[]
  maps: string[]
  totalMods: number
  iniPath?: string
  error?: string
  workshopModMap?: Record<
    string,
    Array<{ id: string; name: string; enabled: boolean; require?: string[] }>
  >
  duplicateKeys?: Array<{ key: string; count: number }>
}

function parseSteamCommunityUrl(input: string): URL | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`,
    )
    if (
      url.protocol !== 'https:' ||
      !['steamcommunity.com', 'www.steamcommunity.com'].includes(
        url.hostname.toLowerCase(),
      )
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}

function parseWorkshopId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const numericMatch = trimmed.match(/^(\d{6,15})$/)
  if (numericMatch) return numericMatch[1]
  const url = parseSteamCommunityUrl(trimmed)
  const id = url?.searchParams.get('id')
  return id && /^\d{1,15}$/.test(id) ? id : null
}

type ModsView =
  | 'installed'
  | 'active'
  | 'order'
  | 'add'
  | 'collection'
  | 'conflicts'
  | 'presets'
  | 'tools'
  | 'deactivated'

const CONFIG_VIEWS: ModsView[] = ['active', 'order', 'add', 'presets', 'tools']

function getModsNav(): Array<{
  group: string
  items: Array<{ id: ModsView; label: string; hint: string }>
}> {
  return [
    {
      group: 'Mods',
      items: [
        {
          id: 'installed',
          label: 'Installed',
          hint: 'Workshop items this panel tracks for updates',
        },
        {
          id: 'active',
          label: 'Active on server',
          hint: 'What the server config actually loads',
        },
        {
          id: 'deactivated',
          label: 'Deactivated',
          hint: 'Tracked items currently switched off',
        },
      ],
    },
    {
      group: 'Add',
      items: [
        { id: 'add', label: 'Add mods', hint: 'Add by Workshop ID or URL' },
        {
          id: 'collection',
          label: 'Import collection',
          hint: 'Pull every item from a Steam collection',
        },
        { id: 'order', label: 'Load order', hint: 'Order mods are loaded in' },
      ],
    },
    {
      group: 'Maintenance',
      items: [
        {
          id: 'conflicts',
          label: 'Conflicts',
          hint: 'Clashes and missing dependencies',
        },
        { id: 'presets', label: 'Presets', hint: 'Save and restore mod sets' },
        {
          id: 'tools',
          label: 'Tools',
          hint: 'Repair, deduplicate, and cleanup',
        },
      ],
    },
  ]
}

const STEAM_API_ISSUE_DISMISSED_KEY = 'pz-mods-steam-api-issue-dismissed'

export default function Mods() {
  const MODS_NAV = useMemo(() => getModsNav(), [])
  const { searchStr } = useLocation()
  const searchParams = new URLSearchParams(searchStr)
  const reviewUnresolved = searchParams.get('review') === 'unresolved'
  const reviewDeepLinkStarted = useRef(false)
  const demoMode = isDemoMode()
  const [mods, setMods] = useState<TrackedMod[]>([])
  const [status, setStatus] = useState<ModStatus | null>(null)
  const [steamApiIssueDismissed, setSteamApiIssueDismissed] = useState<
    string | null
  >(() => {
    try {
      return localStorage.getItem(STEAM_API_ISSUE_DISMISSED_KEY)
    } catch {
      return null
    }
  })
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [workshopBrowserOpen, setWorkshopBrowserOpen] = useState(false)
  const [workshopBrowserInitialPath, setWorkshopBrowserInitialPath] = useState<
    string | undefined
  >()
  const [savingWorkshopPath, setSavingWorkshopPath] = useState(false)
  const { toast } = useToast()
  const confirm = useConfirm()
  const canManageMods = true
  const canManageServers = true

  const [searchQuery, setSearchQuery] = useState('')
  const [deferredSearchQuery, setDeferredSearchQuery] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trackedModsRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [showUpdatesOnly, setShowUpdatesOnly] = useState(false)
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set())

  const [showDisabled, setShowDisabled] = useState(false)
  const [disabledMods, setDisabledMods] = useState<
    Array<{ workshop_id: string; name: string }>
  >([])
  const [disabledLoading, setDisabledLoading] = useState(false)
  const [enablingId, setEnablingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  usePageShortcut(
    'k',
    () => {
      searchInputRef.current?.focus()
    },
    { ctrl: true },
  )

  const [advancedAddOpen, setAdvancedAddOpen] = useState(false)
  const [advancedModInput, setAdvancedModInput] = useState('')
  const [discoveringMod, setDiscoveringMod] = useState(false)
  const [showAdvancedIdSelection, setShowAdvancedIdSelection] = useState(false)
  const [discoveredMod, setDiscoveredMod] = useState<{
    workshopId: string
    name: string
    description: string | null
    modIds: string[]
    hasMultipleModIds: boolean
    isMap: boolean
    mapFolders: string[]
    isDownloaded: boolean
    tags: string[]
    alreadyConfigured?: string[]
    isAlreadyAdded?: boolean
  } | null>(null)
  const [selectedModIds, setSelectedModIds] = useState<Set<string>>(new Set())

  const [collectionUrl, setCollectionUrl] = useState('')
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false)
  const [collectionMods, setCollectionMods] = useState<CollectionMod[]>([])
  const [importingCollection, setImportingCollection] = useState(false)
  const [collectionImported, setCollectionImported] = useState(false)
  const [showCollectionAdvanced, setShowCollectionAdvanced] = useState(false)

  const [iniConfig, setIniConfig] = useState<IniConfig | null>(null)
  const [modsToInstall, setModsToInstall] = useState<CollectionMod[]>([])
  const [orderedModIds, setOrderedModIds] = useState<string[]>([])
  const [selectedActiveWsId, setSelectedActiveWsId] = useState<string | null>(
    null,
  )
  const [savingModOrder, setSavingModOrder] = useState(false)
  const [serverChangedSinceLoad, setServerChangedSinceLoad] = useState(false)
  const [autoSortPreview, setAutoSortPreview] = useState<AutoSortResult | null>(
    null,
  )
  const [draggedModIndex, setDraggedModIndex] = useState<number | null>(null)
  const [repairingMaps, setRepairingMaps] = useState(false)
  const [mapRepairResult, setMapRepairResult] = useState<{
    removed: string[]
    added?: string[]
    remaining: string[]
    message: string
  } | null>(null)
  const [confirmRemoveMod, setConfirmRemoveMod] = useState<string | null>(null)
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false)
  const [ignoredMods, setIgnoredMods] = useState<
    Array<{ workshop_id: string; name: string | null; ignored_at: string }>
  >([])
  const [ignoredModsOpen, setIgnoredModsOpen] = useState(false)
  const [ignoredPairs, setIgnoredPairs] = useState<
    Array<{ mod_a: string; mod_b: string; reason?: string | null }>
  >([])
  const [confirmRemoveWorkshop, setConfirmRemoveWorkshop] = useState<{
    wsId: string
    knownModIds: string[]
  } | null>(null)
  const [deduplicating, setDeduplicating] = useState(false)
  const [deduplicateResult, setDeduplicateResult] = useState<string | null>(
    null,
  )
  const [filterMultiId, setFilterMultiId] = useState(true)
  const [filterAttention, setFilterAttention] = useLocalStorageState<boolean>(
    'zcp:mods:active:attentionOnly',
    false,
  )
  const [activeDensity, setActiveDensity] = useLocalStorageState<
    'compact' | 'detailed'
  >('zcp:mods:active:density', 'compact')
  const [modManagerSearch, setModManagerSearch] = useState('')
  const [deferredModManagerSearch, setDeferredModManagerSearch] = useState('')
  const modSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [configSubTab, setConfigSubTab] = useState<
    'active' | 'order' | 'add' | 'presets' | 'tools'
  >('active')
  const [lastSavedMod, setLastSavedMod] = useState<string | null>(null)
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyRef = useRef(false)
  const discoverAbortRef = useRef<AbortController | null>(null)

  const [restartSettingsOpen, setRestartSettingsOpen] = useState(false)
  const [restartWarningMinutes, setRestartWarningMinutes] = useState(5)
  const [delayIfPlayersOnline, setDelayIfPlayersOnline] = useState(false)
  const [maxDelayMinutes, setMaxDelayMinutes] = useState(30)

  const [conflicts, setConflicts] = useState<ConflictScanResult | null>(null)
  const [conflictsLoading, setConflictsLoading] = useState(false)
  const [conflictsError, setConflictsError] = useState<string | null>(null)
  const [lastScanTime, setLastScanTime] = useState<Date | null>(null)
  const [scanIniSnapshot, setScanIniSnapshot] = useState<string | null>(null)
  const [scanProgress, setScanProgress] = useState(0)
  const [scanCurrentMod, setScanCurrentMod] = useState<string | null>(null)
  const [scanModsScanned, setScanModsScanned] = useState(0)
  const [scanTotalMods, setScanTotalMods] = useState(0)
  const [streamConflicts, setStreamConflicts] = useState<
    ScanStreamConflictFound[]
  >([])
  const eventSourceRef = useRef<EventSource | null>(null)
  const closingIntentionallyRef = useRef(false)
  const sseIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scanBatchRef = useRef<{
    progress: number
    modName: string | null
    modsScanned: number
    dirty: boolean
    raf: number
  }>({ progress: 0, modName: null, modsScanned: 0, dirty: false, raf: 0 })

  const [activeTab, setActiveTab] = useState<ModsView>(
    reviewUnresolved ? 'conflicts' : 'installed',
  )

  const [depAdding, setDepAdding] = useState<string[]>([])
  const [depAddResults, setDepAddResults] = useState<
    Record<string, 'added' | 'error'>
  >({})
  const [depSearchOpen, setDepSearchOpen] = useState<Set<string>>(new Set())
  const [depSearchData, setDepSearchData] = useState<
    Record<string, DepSearchState>
  >({})

  const [collectionStatus, setCollectionStatus] = useState<{
    configured: boolean
    autoSync: boolean
    inSync: boolean
    drift: number
    title: string | null
    error: string | null
    loading: boolean
  }>({
    configured: false,
    autoSync: false,
    inSync: false,
    drift: 0,
    title: null,
    error: null,
    loading: false,
  })
  const [collectionSyncing, setCollectionSyncing] = useState(false)
  useEffect(() => {
    return () => {
      closingIntentionallyRef.current = true
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      sseIdleTimerRef.current = null
      cancelAnimationFrame(scanBatchRef.current.raf)
    }
  }, [])

  const conflictsStale = useMemo(() => {
    if (!conflicts || !scanIniSnapshot) return false
    const currentSnapshot = createConflictScanSnapshot(
      iniConfig?.workshopIds,
      iniConfig?.modIds,
    )
    return currentSnapshot !== scanIniSnapshot
  }, [conflicts, scanIniSnapshot, iniConfig?.workshopIds, iniConfig?.modIds])

  const autoDiscoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const lastAutoDiscoverIdRef = useRef<string | null>(null)

  interface ModPreset {
    id: number
    name: string
    description: string
    workshop_ids: string[]
    mods: string[]
    created_at: string
    updated_at: string
  }
  const [presets, setPresets] = useState<ModPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [savePresetOpen, setSavePresetOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetDescription, setPresetDescription] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const [applyingPreset, setApplyingPreset] = useState<number | null>(null)
  const [confirmApplyPreset, setConfirmApplyPreset] = useState<{
    id: number
    name: string
    modCount: number
  } | null>(null)
  const [confirmDeletePreset, setConfirmDeletePreset] = useState<{
    id: number
    name: string
  } | null>(null)

  interface ModConflict {
    type: 'duplicate' | 'missing_modid' | 'outdated_dependency'
    severity: 'warning' | 'info'
    message: string
    modIds?: string[]
  }

  const detectedConflicts = useMemo((): ModConflict[] => {
    if (!iniConfig?.configured) return []
    const conflicts: ModConflict[] = []

    const modIdCounts: Record<string, number> = {}
    for (const modId of iniConfig.modIds) {
      modIdCounts[modId] = (modIdCounts[modId] || 0) + 1
    }
    const duplicates = Object.entries(modIdCounts).filter(
      ([, count]) => count > 1,
    )
    if (duplicates.length > 0) {
      conflicts.push({
        type: 'duplicate',
        severity: 'warning',
        message:
          'Duplicate mod IDs found: ' +
          String(duplicates.map(([id]) => id).join(', ')),
        modIds: duplicates.map(([id]) => id),
      })
    }

    const workshopCount = iniConfig.workshopIds?.length || 0
    const modIdCount = iniConfig.modIds?.length || 0
    if (workshopCount > 0 && modIdCount === 0) {
      conflicts.push({
        type: 'missing_modid',
        severity: 'info',
        message:
          String(workshopCount) +
          ' workshop items configured but no mod IDs. Run "Sync Mod IDs" after downloading mods.',
      })
    }

    return conflicts
  }, [iniConfig])

  useEffect(() => {
    return () => {
      if (autoDiscoverTimeoutRef.current) {
        clearTimeout(autoDiscoverTimeoutRef.current)
      }
      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current)
      }
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }
      if (trackedModsRetryRef.current) {
        clearTimeout(trackedModsRetryRef.current)
      }
      if (modSearchTimerRef.current) {
        clearTimeout(modSearchTimerRef.current)
      }
      discoverAbortRef.current?.abort()
      discoverAbortRef.current = null
      eventSourceRef.current?.close()
    }
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(
      () => setDeferredSearchQuery(value),
      300,
    )
  }, [])

  const handleModManagerSearchChange = useCallback((value: string) => {
    setModManagerSearch(value)
    if (modSearchTimerRef.current) clearTimeout(modSearchTimerRef.current)
    modSearchTimerRef.current = setTimeout(
      () => setDeferredModManagerSearch(value),
      300,
    )
  }, [])

  const fetchData = useCallback(async () => {
    setFetchError(null)
    try {
      const results = await Promise.allSettled([
        modsApi.getTrackedMods(),
        modsApi.getStatus(),
        modsApi.getCurrentConfig(),
        modsApi.getIgnoredMods(),
        modsApi.getIgnoredModPairs(),
      ])

      const allRejected403 = results.every(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof ApiError &&
          r.reason.status === 403,
      )
      if (allRejected403) {
        setPermissionDenied(true)
        return
      }
      setPermissionDenied(false)

      if (results[0].status === 'fulfilled') {
        setMods(results[0].value.mods || [])
      } else {
        reportClientError('Failed to fetch tracked mods.', results[0].reason)
        setFetchError('Mod list is temporarily unavailable. Retrying...')
        if (trackedModsRetryRef.current)
          clearTimeout(trackedModsRetryRef.current)
        trackedModsRetryRef.current = setTimeout(async () => {
          try {
            const retry = await modsApi.getTrackedMods()
            setMods(retry.mods || [])
            setFetchError(null)
          } catch (error) {
            reportClientError('Failed to retry tracked mods fetch.', error)
            setFetchError(
              'Unable to load the mod list. Use Sync or reload the page to retry.',
            )
          }
        }, 1500)
      }
      if (results[1].status === 'fulfilled') {
        const statusData = results[1].value
        setStatus(statusData)
        if (statusData) {
          setRestartWarningMinutes(statusData.restartWarningMinutes || 5)
          setDelayIfPlayersOnline(statusData.delayIfPlayersOnline || false)
          setMaxDelayMinutes(statusData.maxDelayMinutes || 30)
        }
      }
      if (results[2].status === 'fulfilled') {
        setIniConfig(results[2].value)
        if (results[2].value?.modIds) {
          setOrderedModIds(results[2].value.modIds)
        }
      }
      if (results[3].status === 'fulfilled') {
        setIgnoredMods(Array.isArray(results[3].value) ? results[3].value : [])
      }
      if (results[4].status === 'fulfilled') {
        setIgnoredPairs(Array.isArray(results[4].value) ? results[4].value : [])
      }

      const failures = results.filter((r) => r.status === 'rejected')
      if (failures.length > 0) {
        failures.forEach((result, index) => {
          reportClientError(
            `Failed to fetch mods data (index ${index}).`,
            (result as PromiseRejectedResult).reason,
          )
        })
        if (failures.length === results.length) {
          setFetchError(
            'Failed to load mod data. The backend may be unreachable.',
          )
        }
      }
    } catch (error) {
      reportClientError('Failed to fetch mods data.', error)
      setFetchError('Failed to load mod data. The backend may be unreachable.')
    }
    fetchCollectionStatusRef.current?.().catch(() => {})
  }, [])

  const handleOpenWorkshopBrowser = useCallback(async () => {
    try {
      const { server } = await serversApi.getActive()
      if (!server) {
        toast({
          title: 'No active server',
          description:
            'Select a local server before choosing a workshop folder.',
          variant: 'destructive',
        })
        return
      }
      if (server.isRemote) {
        toast({
          title: 'Remote server',
          description:
            'Workshop update detection requires the server files to be local to the panel.',
          variant: 'destructive',
        })
        return
      }
      const installPath = server?.installPath?.trim() || ''
      const lastSlash = Math.max(
        installPath.lastIndexOf('\\'),
        installPath.lastIndexOf('/'),
      )
      const isStartupScript = /\.(bat|cmd|exe|sh)$/i.test(installPath)
      setWorkshopBrowserInitialPath(
        isStartupScript && lastSlash >= 0
          ? installPath.slice(0, lastSlash)
          : installPath || undefined,
      )
    } catch (error) {
      reportClientWarning(
        'Could not load the active server path before opening the folder browser.',
        error,
      )
      toast({
        title: 'Could not open folder browser',
        description: getUserErrorMessage(
          error,
          'The active server could not be loaded.',
        ),
        variant: 'destructive',
      })
      return
    }
    setWorkshopBrowserOpen(true)
  }, [toast])

  const handleWorkshopFolderSelected = useCallback(
    async (selectedPath: string) => {
      if (savingWorkshopPath || !selectedPath.trim() || !canManageServers)
        return
      setSavingWorkshopPath(true)
      try {
        const { server } = await serversApi.getActive()
        await serversApi.update(server.id, { installPath: selectedPath.trim() })
        await fetchData()
        toast({
          title: 'Workshop path connected',
          description: 'Update detection is ready.',
        })
      } catch (error) {
        toast({
          title: 'Could not save workshop path',
          description: getUserErrorMessage(
            error,
            'Choose the folder containing the PZ server files.',
          ),
          variant: 'destructive',
        })
      } finally {
        setSavingWorkshopPath(false)
      }
    },
    [fetchData, savingWorkshopPath, toast, canManageServers],
  )

  const fetchDisabled = useCallback(async () => {
    setDisabledLoading(true)
    try {
      const result = await modsApi.listDiskOnly()
      setDisabledMods(result.mods || [])
    } catch (error) {
      reportClientError('Failed to fetch disabled mods.', error)
      toast({
        title: "Couldn't scan for disabled mods",
        description: 'The workshop folder scan failed. Try refreshing again.',
        variant: 'destructive',
      })
    } finally {
      setDisabledLoading(false)
    }
  }, [toast])

  const handleEnableDiskMod = useCallback(
    async (workshopId: string) => {
      if (enablingId || !canManageMods) return
      setEnablingId(workshopId)
      try {
        const r = await modsApi.enableDiskMod(workshopId)
        toast({
          title: 'Mod enabled',
          description:
            Number(r.modIdsAdded) === 1
              ? 'Added to server INI (' +
                String(r.modIdsAdded) +
                ' mod ID). Restart the server to load it.'
              : 'Added to server INI (' +
                String(r.modIdsAdded) +
                ' mod IDs). Restart the server to load it.',
        })
        await Promise.allSettled([fetchData(), fetchDisabled()])
      } catch (error) {
        toast({
          title: 'Enable failed',
          description: getUserErrorMessage(error, 'Failed to enable mod'),
          variant: 'destructive',
        })
      } finally {
        setEnablingId(null)
      }
    },
    [enablingId, toast, fetchData, fetchDisabled, canManageMods],
  )

  const handleDeleteDiskMod = useCallback(
    async (workshopId: string, modName?: string) => {
      if (deletingId || !canManageMods) return
      const label = modName ? `"${modName}" (${workshopId})` : workshopId
      const ok = await confirm({
        title: 'Delete mod from disk?',
        description:
          'Delete ' +
          String(label) +
          ' from disk? This removes the workshop folder and strips it from the server INI. This cannot be undone (Steam will re-download on next start if the mod is still in WorkshopItems= elsewhere).',
        confirmLabel: 'Delete',
      })
      if (!ok) {
        return
      }
      setDeletingId(workshopId)
      try {
        const r = await modsApi.deleteDiskMod(workshopId)
        toast({
          title: 'Mod deleted',
          description: r.deletedFromDisk
            ? Number(r.modIdsStripped) === 1
              ? 'Removed from disk (' +
                String(r.modIdsStripped) +
                ' mod ID stripped from INI).'
              : 'Removed from disk (' +
                String(r.modIdsStripped) +
                ' mod IDs stripped from INI).'
            : 'Folder was already missing; INI cleaned up.',
        })
        await Promise.allSettled([fetchData(), fetchDisabled()])
      } catch (error) {
        toast({
          title: 'Delete failed',
          description: getUserErrorMessage(error, 'Failed to delete mod'),
          variant: 'destructive',
        })
      } finally {
        setDeletingId(null)
      }
    },
    [deletingId, toast, fetchData, fetchDisabled, canManageMods, confirm],
  )

  const handleDeleteAllDisabled = useCallback(async () => {
    if (deletingId || disabledMods.length === 0 || !canManageMods) return
    const ok = await confirm({
      title: 'Delete disabled mods from disk?',
      description:
        Number(disabledMods.length) === 1
          ? 'Delete all ' +
            String(disabledMods.length) +
            ' disabled mod from disk? This removes every workshop folder listed below.'
          : 'Delete all ' +
            String(disabledMods.length) +
            ' disabled mods from disk? This removes every workshop folder listed below.',
      items: disabledMods.map((m) => m.name || m.workshop_id),
      confirmLabel: 'Delete all',
    })
    if (!ok) {
      return
    }
    setDeletingId('__batch_disabled__')
    try {
      const ids = disabledMods.map((m) => m.workshop_id)
      const r = await modsApi.batchDeleteDiskMods(ids)
      toast({
        title: 'Bulk delete complete',
        description:
          (Number(r.total) === 1
            ? 'Deleted ' +
              String(r.deletedFromDisk) +
              '/' +
              String(r.total) +
              ' mod folder'
            : 'Deleted ' +
              String(r.deletedFromDisk) +
              '/' +
              String(r.total) +
              ' mod folders') +
          (Number(r.modIdsStripped) === 1
            ? ' (' + String(r.modIdsStripped) + ' mod ID stripped from INI).'
            : ' (' + String(r.modIdsStripped) + ' mod IDs stripped from INI).'),
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: 'Bulk delete failed',
        description: getUserErrorMessage(error, 'Failed to delete mods'),
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [
    deletingId,
    disabledMods,
    toast,
    fetchData,
    fetchDisabled,
    canManageMods,
    confirm,
  ])

  const handleDeleteAllIgnoredFromDisk = useCallback(async () => {
    if (deletingId || ignoredMods.length === 0 || !canManageMods) return
    const ok = await confirm({
      title: 'Delete ignored mods from disk?',
      description:
        Number(ignoredMods.length) === 1
          ? 'Delete all ' +
            String(ignoredMods.length) +
            ' ignored mod from disk? This removes every workshop folder listed below AND clears the ignore list.'
          : 'Delete all ' +
            String(ignoredMods.length) +
            ' ignored mods from disk? This removes every workshop folder listed below AND clears the ignore list.',
      items: ignoredMods.map((m) => m.name || m.workshop_id),
      confirmLabel: 'Delete all',
    })
    if (!ok) {
      return
    }
    setDeletingId('__batch_ignored__')
    try {
      const ids = ignoredMods.map((m) => m.workshop_id)
      const r = await modsApi.batchDeleteDiskMods(ids)
      toast({
        title: 'Bulk delete complete',
        description:
          (Number(r.total) === 1
            ? 'Deleted ' +
              String(r.deletedFromDisk) +
              '/' +
              String(r.total) +
              ' mod folder'
            : 'Deleted ' +
              String(r.deletedFromDisk) +
              '/' +
              String(r.total) +
              ' mod folders') +
          (Number(r.modIdsStripped) === 1
            ? ' (' + String(r.modIdsStripped) + ' mod ID stripped from INI).'
            : ' (' + String(r.modIdsStripped) + ' mod IDs stripped from INI).'),
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: 'Bulk delete failed',
        description: getUserErrorMessage(error, 'Failed to delete mods'),
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [
    deletingId,
    ignoredMods,
    toast,
    fetchData,
    fetchDisabled,
    canManageMods,
    confirm,
  ])

  const fetchCollectionStatusRef = useRef<() => Promise<void>>(async () => {})
  const collectionEverConfiguredRef = useRef(true)
  const fetchCollectionStatus = useCallback(async () => {
    if (!collectionEverConfiguredRef.current) return
    setCollectionStatus((s) => ({ ...s, loading: true }))
    try {
      const r = await modsApi.collectionDiff()
      collectionEverConfiguredRef.current = !!r.collectionId
      setCollectionStatus({
        configured: !!r.collectionId,
        autoSync: !!r.autoSync,
        inSync: r.ok && r.toAdd.length === 0 && r.toRemove.length === 0,
        drift: r.ok ? r.toAdd.length + r.toRemove.length : 0,
        title: r.title || null,
        error: r.ok ? null : r.error || null,
        loading: false,
      })
    } catch (err: any) {
      setCollectionStatus((s) => ({
        ...s,
        loading: false,
        error: getUserErrorMessage(err, 'Network error'),
      }))
    }
  }, [])

  useEffect(() => {
    fetchCollectionStatusRef.current = fetchCollectionStatus
  }, [fetchCollectionStatus])

  useEffect(() => {
    const onFocus = () => {
      if (!collectionEverConfiguredRef.current) {
        collectionEverConfiguredRef.current = true
        fetchCollectionStatusRef.current?.().catch(() => {})
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])

  const handleCollectionSyncNow = useCallback(async () => {
    if (collectionSyncing || !canManageMods) return
    setCollectionSyncing(true)
    try {
      const r = await modsApi.collectionSync()
      toast({
        title: r.success ? 'Collection synced' : 'Partial sync',
        description: r.message,
        variant: r.success ? 'default' : 'destructive',
      })
      fetchCollectionStatus()
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Sync Failed',
        description: getUserErrorMessage(err, 'Unknown error'),
      })
    } finally {
      setCollectionSyncing(false)
    }
  }, [collectionSyncing, fetchCollectionStatus, toast, canManageMods])

  const fetchPresets = useCallback(async () => {
    setPresetsLoading(true)
    try {
      const data = await modsApi.getPresets()
      setPresets(data.presets || [])
    } catch (error) {
      reportClientError('Failed to fetch presets.', error)
      setFetchError('Failed to load presets')
    } finally {
      setPresetsLoading(false)
    }
  }, [])

  const socket = useSocket()
  useEffect(() => {
    if (!socket) return
    const refresh = () => {
      fetchData()
    }
    socket.on('mods:update_detected', refresh)
    socket.on('mods:restart_pending', refresh)
    socket.on('mods:restart_starting', refresh)
    socket.on('mods:restart_cancelled', refresh)
    socket.on('mods:restart_failed', refresh)
    socket.on('mods:restart_complete', refresh)
    socket.on('mods:updates_available', refresh)
    return () => {
      socket.off('mods:update_detected', refresh)
      socket.off('mods:restart_pending', refresh)
      socket.off('mods:restart_starting', refresh)
      socket.off('mods:restart_cancelled', refresh)
      socket.off('mods:restart_failed', refresh)
      socket.off('mods:restart_complete', refresh)
      socket.off('mods:updates_available', refresh)
    }
  }, [socket, fetchData])

  useEffect(() => {
    let mounted = true
    const initializeData = async () => {
      await Promise.allSettled([
        fetchData(),
        fetchPresets(),
        fetchCollectionStatus(),
      ])
      if (!mounted) return
      try {
        const cached = await modsApi.getCachedConflicts()
        if (!mounted) return
        if (cached) {
          setConflicts(cached)
          setConflictsError(null)
          setLastScanTime(new Date())
          setScanIniSnapshot(
            createConflictScanSnapshot(
              cached._workshopIdsSnapshot,
              cached._modIdsSnapshot,
            ),
          )
          if (cached.stale) {
            // Config changed since last scan — the stale banner will show
          }
        }
      } catch {
        /* non-fatal — user can still trigger a fresh scan */
      }
    }
    initializeData()
    return () => {
      mounted = false
    }
  }, [fetchData, fetchPresets, fetchCollectionStatus])

  const handleSavePreset = async () => {
    if (!presetName.trim() || !canManageMods) return
    setSavingPreset(true)
    try {
      await modsApi.createPreset(presetName.trim(), presetDescription.trim())
      toast({
        title: 'Preset Saved',
        description: 'Mod preset "' + String(presetName) + '" has been saved',
        variant: 'success' as const,
      })
      setSavePresetOpen(false)
      setPresetName('')
      setPresetDescription('')
      fetchPresets()
    } catch (error) {
      toast({
        title: 'Preset Save Failed',
        description: getUserErrorMessage(error, 'Failed to save preset'),
        variant: 'destructive',
      })
    } finally {
      setSavingPreset(false)
    }
  }

  const handleApplyPreset = async (id: number, _name: string) => {
    if (!canManageMods) return
    setApplyingPreset(id)
    try {
      const result = await modsApi.applyPreset(id)
      toast({
        title: 'Preset Applied',
        description: result.message,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Preset Apply Failed',
        description: getUserErrorMessage(error, 'Failed to apply preset'),
        variant: 'destructive',
      })
    } finally {
      setApplyingPreset(null)
      fetchData()
    }
  }

  const handleDeletePreset = async (id: number, name: string) => {
    if (!canManageMods) return
    try {
      await modsApi.deletePreset(id)
      toast({
        title: 'Preset Deleted',
        description: 'Preset "' + String(name) + '" has been deleted',
        variant: 'success' as const,
      })
      fetchPresets()
    } catch (error) {
      toast({
        title: 'Preset Delete Failed',
        description: getUserErrorMessage(error, 'Failed to delete preset'),
        variant: 'destructive',
      })
    }
  }

  const filteredMods = useMemo(() => {
    let result = [...mods]

    if (deferredSearchQuery) {
      const query = deferredSearchQuery.toLowerCase()
      result = result.filter(
        (m) =>
          m.name?.toLowerCase().includes(query) ||
          m.workshop_id.includes(query),
      )
    }

    if (showUpdatesOnly) {
      result = result.filter((m) => m.update_available)
    }

    return result.sort((a, b) => {
      if (a.update_available !== b.update_available) {
        return b.update_available - a.update_available
      }
      return (a.name || '').localeCompare(b.name || '')
    })
  }, [mods, deferredSearchQuery, showUpdatesOnly])

  const configuredWorkshopIds = useMemo(
    () => new Set(iniConfig?.workshopIds || []),
    [iniConfig?.workshopIds],
  )
  const groupedMods = useMemo(() => {
    const updateAvailable: TrackedMod[] = []
    const neverChecked: TrackedMod[] = []
    const upToDate: TrackedMod[] = []
    const deactivated: TrackedMod[] = []
    const configLoaded = iniConfig !== null
    for (const mod of filteredMods) {
      if (configLoaded && !configuredWorkshopIds.has(mod.workshop_id)) {
        deactivated.push(mod)
        continue
      }
      if (mod.update_available) updateAvailable.push(mod)
      else if (!mod.last_checked) neverChecked.push(mod)
      else upToDate.push(mod)
    }
    return { updateAvailable, neverChecked, upToDate, deactivated }
  }, [filteredMods, iniConfig, configuredWorkshopIds])

  const visibleServerMods = useMemo(
    () => [
      ...groupedMods.updateAvailable,
      ...groupedMods.neverChecked,
      ...groupedMods.upToDate,
    ],
    [groupedMods],
  )

  const removedWorkshopMods = useMemo(() => {
    const byId = new Map(mods.map((m) => [m.workshop_id, m]))
    return (status?.removedWorkshopIds || []).map((id) => ({
      workshopId: id,
      name: byId.get(id)?.name || null,
    }))
  }, [status?.removedWorkshopIds, mods])

  const [upToDateExpanded, setUpToDateExpanded] = useState(false)
  const [neverCheckedExpanded, setNeverCheckedExpanded] = useState(false)
  useEffect(() => {
    if (deferredSearchQuery) {
      setUpToDateExpanded(true)
      setNeverCheckedExpanded(true)
    } else {
      setUpToDateExpanded(false)
      setNeverCheckedExpanded(false)
    }
  }, [deferredSearchQuery])

  useEffect(() => {
    if (deferredSearchQuery) return
    if (
      groupedMods.neverChecked.length > 0 &&
      groupedMods.updateAvailable.length === 0 &&
      groupedMods.upToDate.length === 0
    ) {
      setNeverCheckedExpanded(true)
    }
  }, [groupedMods, deferredSearchQuery])

  const handleCheckUpdates = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setChecking(true)
    try {
      const result = await modsApi.checkUpdates()
      const count =
        (Array.isArray(result?.mods) ? result.mods.length : 0) ||
        (typeof result?.updatesFound === 'number' ? result.updatesFound : 0)
      if (result?.error) {
        toast({
          title: 'Update Check Failed',
          description: String(result.error),
          variant: 'destructive',
        })
      } else if (result?.skipped) {
        toast({
          title: 'Update Check Skipped',
          description: 'A check is already in progress.',
        })
      } else {
        toast({
          title: 'Updates Checked',
          description:
            count === 0
              ? 'All mods up to date'
              : Number(count) === 1
                ? String(count) + ' mod has updates available'
                : String(count) + ' mods have updates available',
        })
      }
      fetchData()
    } catch (error) {
      toast({
        title: 'Update Check Failed',
        description: getUserErrorMessage(error, 'Failed to check updates'),
        variant: 'destructive',
      })
    } finally {
      setChecking(false)
      busyRef.current = false
    }
  }

  const discoverWorkshopMod = useCallback(
    async (workshopId: string) => {
      if (discoveringMod || !canManageMods) return

      discoverAbortRef.current?.abort()
      const controller = new AbortController()
      discoverAbortRef.current = controller

      if (iniConfig?.workshopIds?.includes(workshopId)) {
        toast({
          title: 'Already Added',
          description: 'This mod is already in your server configuration',
          variant: 'default',
        })
        return
      }

      setDiscoveringMod(true)
      setDiscoveredMod(null)
      setSelectedModIds(new Set())

      try {
        const result = await modsApi.discoverModIds(workshopId, undefined, {
          signal: controller.signal,
        })

        const seenIds = new Set<string>()
        const uniqueModIds = result.modIds.filter((id) => {
          const lower = id.toLowerCase()
          if (seenIds.has(lower)) return false
          seenIds.add(lower)
          return true
        })

        const alreadyConfigured = uniqueModIds.filter((id) =>
          iniConfig?.modIds?.includes(id),
        )

        const newResult = {
          ...result,
          modIds: uniqueModIds,
          hasMultipleModIds: uniqueModIds.length > 1,
          alreadyConfigured,
          isAlreadyAdded: iniConfig?.workshopIds?.includes(workshopId) || false,
        }

        setDiscoveredMod(newResult)

        const newModIds = uniqueModIds.filter(
          (id) => !alreadyConfigured.includes(id),
        )
        setSelectedModIds(new Set(newModIds))

        if (uniqueModIds.length === 0) {
          toast({
            title: 'No Mod IDs Found',
            description: result.isDownloaded
              ? 'Mod is downloaded but no mod.info files found'
              : 'Mod not yet downloaded. Add it anyway and sync after the server downloads it.',
            variant: 'default',
          })
        } else if (
          alreadyConfigured.length > 0 &&
          alreadyConfigured.length === uniqueModIds.length
        ) {
          toast({
            title: 'Already Configured',
            description:
              'All mod IDs from this workshop item are already in your server config',
            variant: 'default',
          })
        } else if (newResult.hasMultipleModIds) {
          toast({
            title: 'Multiple Mod IDs Found',
            description:
              'Found ' +
              String(uniqueModIds.length) +
              ' mod IDs. ' +
              String(newModIds.length) +
              ' new, ' +
              String(alreadyConfigured.length) +
              ' already configured.',
          })
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        toast({
          title: 'Discovery Failed',
          description: getUserErrorMessage(
            error,
            'Failed to discover mod IDs. Check the Workshop ID and try again.',
          ),
          variant: 'destructive',
        })
      } finally {
        setDiscoveringMod(false)
      }
    },
    [
      discoveringMod,
      iniConfig?.modIds,
      iniConfig?.workshopIds,
      toast,
      canManageMods,
    ],
  )

  const handleModInputChange = useCallback(
    (value: string) => {
      setAdvancedModInput(value)

      if (autoDiscoverTimeoutRef.current) {
        clearTimeout(autoDiscoverTimeoutRef.current)
        autoDiscoverTimeoutRef.current = null
      }

      const workshopId = parseWorkshopId(value)
      if (workshopId && workshopId !== lastAutoDiscoverIdRef.current) {
        lastAutoDiscoverIdRef.current = workshopId
        autoDiscoverTimeoutRef.current = setTimeout(() => {
          void discoverWorkshopMod(workshopId)
        }, 200)
      }
    },
    [discoverWorkshopMod],
  )

  const handleDiscoverMod = async () => {
    if (!canManageMods) return
    const workshopId = parseWorkshopId(advancedModInput)

    if (!workshopId) {
      toast({
        title: 'Invalid Workshop URL',
        description: 'Enter a Workshop URL or numeric ID. Example: 3616536783',
        variant: 'destructive',
      })
      return
    }

    await discoverWorkshopMod(workshopId)
  }

  const handleAddModAdvanced = async () => {
    if (!discoveredMod || busyRef.current || !canManageMods) return
    busyRef.current = true

    setLoading(true)
    try {
      const modIdsArray = Array.from(selectedModIds)

      await modsApi.trackMod(discoveredMod.workshopId)

      const result = await modsApi.addModAdvanced(
        discoveredMod.workshopId,
        modIdsArray.length > 0 ? modIdsArray : undefined,
        modIdsArray.length === 0,
      )

      if (result.addedModIds.length > 0) {
        toast({
          title: 'Mod Added to Server Config',
          description:
            String(result.addedModIds.join(', ')) +
            ' written to INI.' +
            String(
              result.mapFoldersAdded.length > 0
                ? Number(result.mapFoldersAdded.length) === 1
                  ? ' Map: ' + String(result.mapFoldersAdded.join(', ')) + '.'
                  : ' Maps: ' + String(result.mapFoldersAdded.join(', ')) + '.'
                : '',
            ) +
            ' Restart the server to load it.',
          variant: 'success' as const,
        })
      } else if (result.workshopAlreadyExisted) {
        toast({
          title: 'Already Configured',
          description: 'This mod is already in your server INI.',
        })
      } else {
        toast({
          title: 'Workshop ID Added',
          description:
            'Added to INI. Mod IDs will be discovered after the server downloads the files.',
        })
      }

      setAdvancedModInput('')
      setDiscoveredMod(null)
      setSelectedModIds(new Set())
      setAdvancedAddOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: 'Add Mod Failed',
        description: getUserErrorMessage(error, 'Failed to add mod'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const toggleModIdSelection = (modId: string) => {
    setSelectedModIds((prev) => {
      const next = new Set(prev)
      if (next.has(modId)) {
        next.delete(modId)
      } else {
        next.add(modId)
      }
      return next
    })
  }
  const handleRemoveMod = async (workshopId: string) => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.batchRemove([workshopId])
      toast({
        title: 'Mod Removed',
        description: 'Removed from server INI config.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Remove Failed',
        description: getUserErrorMessage(error, 'Failed to remove mod'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleEnableMod = async (workshopId: string) => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.addToIni(workshopId)
      toast({
        title: 'Mod Re-enabled',
        description:
          'Added back to server INI. Restart the server for it to load.',
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Enable failed',
        description: getUserErrorMessage(error, 'Failed to enable mod'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleBulkEnable = async (workshopIds: string[]) => {
    if (workshopIds.length === 0 || busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    let ok = 0
    let failed = 0
    try {
      for (const id of workshopIds) {
        try {
          await modsApi.addToIni(id)
          ok++
        } catch {
          failed++
        }
      }
      toast({
        title: failed === 0 ? 'Mods Re-enabled' : 'Partial Re-enable',
        description:
          Number(ok) === 1
            ? 'Added ' +
              String(ok) +
              ' mod back to the INI' +
              String(failed > 0 ? ' · ' + String(failed) + ' failed' : '') +
              '.'
            : 'Added ' +
              String(ok) +
              ' mods back to the INI' +
              String(failed > 0 ? ' · ' + String(failed) + ' failed' : '') +
              '.',
        variant: failed === 0 ? ('success' as const) : ('destructive' as const),
      })
      setSelectedMods(new Set())
      fetchData()
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleRefreshNames = async (workshopIds?: string[]) => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.refreshNames(workshopIds)
      const total = result.totalResolved ?? 0
      const left = result.unresolved ?? 0
      toast({
        title:
          total > 0
            ? Number(total) === 1
              ? 'Resolved ' + String(total) + ' name'
              : 'Resolved ' + String(total) + ' names'
            : 'No new names found',
        description:
          total > 0
            ? String(result.diskResolved) +
              ' from disk · ' +
              String(result.steamResolved) +
              ' from Steam' +
              String(
                left > 0
                  ? ' · ' +
                      String(left) +
                      ' still unknown (deleted/private mod)'
                  : '',
              ) +
              '.'
            : Number(result.checked) === 1
              ? 'Checked ' +
                String(result.checked) +
                ' placeholder name — none could be resolved. The mods may be deleted or private on Steam.'
              : 'Checked ' +
                String(result.checked) +
                ' placeholder names — none could be resolved. The mods may be deleted or private on Steam.',
        variant: total > 0 ? ('success' as const) : ('default' as const),
      })
      if (total > 0) fetchData()
    } catch (error: any) {
      toast({
        title: 'Refresh failed',
        description: getUserErrorMessage(error, 'Could not refresh names'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleBulkRemove = async (workshopIdsOverride?: string[]) => {
    const workshopIds = workshopIdsOverride ?? Array.from(selectedMods)
    if (workshopIds.length === 0 || busyRef.current || !canManageMods) return
    busyRef.current = true

    setLoading(true)

    try {
      const result = (await modsApi.batchRemove(workshopIds)) as {
        success?: boolean
        total?: number
        dbRemoved?: number
        dbFailed?: number
        iniRemoved?: number
        error?: string
      }

      if (result.error) {
        throw new Error(result.error)
      }

      if ((result.dbFailed ?? 0) > 0) {
        toast({
          title: 'Partial Success',
          description:
            'Removed ' +
            String(result.dbRemoved ?? 0) +
            ' mods, ' +
            String(result.dbFailed ?? 0) +
            ' failed to untrack',
          variant: 'destructive',
        })
      } else {
        toast({
          title: 'Success',
          description:
            Number(result.total ?? workshopIds.length) === 1
              ? 'Removed ' +
                String(result.total ?? workshopIds.length) +
                ' mod from tracking and server config'
              : 'Removed ' +
                String(result.total ?? workshopIds.length) +
                ' mods from tracking and server config',
        })
      }
      if (workshopIdsOverride) {
        setSelectedMods((prev) => {
          const next = new Set(prev)
          for (const workshopId of workshopIds) next.delete(workshopId)
          return next
        })
      } else {
        setSelectedMods(new Set())
      }
      fetchData()
    } catch (error) {
      toast({
        title: 'Remove Failed',
        description: getUserErrorMessage(error, 'Failed to remove mods'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleUnignoreMod = async (workshopId: string) => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.unignoreMod(workshopId)
      toast({
        title: 'Mod Un-Ignored',
        description: 'This mod can now be tracked again by auto-sync.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Failed to Un-Ignore Mod',
        description: getUserErrorMessage(error, 'Unknown error'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleClearAllIgnored = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.clearAllIgnoredMods()
      toast({
        title: 'Ignore List Cleared',
        description: result.message || 'All ignored mods removed.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Failed to Clear Ignored Mods',
        description: getUserErrorMessage(error, 'Unknown error'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleToggleAutoRestart = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.setAutoRestart(!status?.autoRestartEnabled)
      toast({
        title: status?.autoRestartEnabled
          ? 'Auto-restart disabled'
          : 'Auto-restart enabled',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Setting Update Failed',
        description: getUserErrorMessage(error, 'Failed to update setting'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleSyncFromServer = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.syncFromServer()
      const parts: string[] = [
        'Synced ' + String(result.synced || 0) + ' mods from server config',
      ]
      if (result.skippedNonMod > 0)
        parts.push(String(result.skippedNonMod) + ' non-mod items filtered')
      if (result.skippedIgnored > 0)
        parts.push(String(result.skippedIgnored) + ' ignored')
      const sentenceEnd = 'en'.startsWith('zh') ? '。' : '. '
      toast({
        title: 'Mods Synced',
        description: parts.join(sentenceEnd) + sentenceEnd.trim(),
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Sync Failed',
        description: getUserErrorMessage(error, 'Failed to sync mods'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleImportCollection = async () => {
    if (!canManageMods) return
    if (!collectionUrl) {
      toast({
        title: 'No URL Entered',
        description:
          'Paste a Steam Workshop collection URL or numeric ID to import.',
        variant: 'destructive',
      })
      return
    }
    const trimmed = collectionUrl.trim()
    if (!/^\d{1,15}$/.test(trimmed) && !parseSteamCommunityUrl(trimmed)) {
      toast({
        title: 'Invalid Format',
        description:
          'Enter a Steam Workshop collection URL or a numeric collection ID.',
        variant: 'destructive',
      })
      return
    }
    if (busyRef.current) return
    busyRef.current = true

    setImportingCollection(true)
    try {
      const result = await modsApi.importCollection(collectionUrl)
      const mods = result.mods || []
      const existingWorkshopIds = new Set(iniConfig?.workshopIds || [])
      setCollectionMods(
        mods.map((m: CollectionMod) => ({
          ...m,
          selected: !existingWorkshopIds.has(m.workshopId),
          modId: '',
          mapFolder: undefined,
        })),
      )
      setCollectionImported(true)

      const subCollectionCount = (result.subCollectionIds || []).length

      if (mods.length === 0) {
        toast({
          title: 'No Mods Found',
          description:
            subCollectionCount > 0
              ? 'Every item in this collection is itself a sub-collection (' +
                String(subCollectionCount) +
                ") — Steam doesn't allow adding those as mods directly. Open the sub-collection on Steam and import it instead."
              : 'This collection appears empty. Check the URL and try again.',
          variant: 'destructive',
        })
      } else {
        toast({
          title: String(mods.length) + ' mods found',
          description:
            subCollectionCount > 0
              ? 'Select which mods to add, then confirm. ' +
                String(subCollectionCount) +
                " item(s) were skipped because they're sub-collections, not mods."
              : 'Select which mods to add, then confirm.',
        })
      }
    } catch (error) {
      toast({
        title: 'Collection Import Failed',
        description: getUserErrorMessage(
          error,
          'Could not fetch collection from Steam. Check the URL and try again.',
        ),
        variant: 'destructive',
      })
    } finally {
      setImportingCollection(false)
      busyRef.current = false
    }
  }

  const toggleModSelection = (workshopId: string) => {
    setCollectionMods((prev) =>
      prev.map((m) =>
        m.workshopId === workshopId ? { ...m, selected: !m.selected } : m,
      ),
    )
  }

  const updateModId = (workshopId: string, modId: string) => {
    setCollectionMods((prev) =>
      prev.map((m) => (m.workshopId === workshopId ? { ...m, modId } : m)),
    )
  }

  const updateMapFolder = (workshopId: string, mapFolder: string) => {
    setCollectionMods((prev) =>
      prev.map((m) => (m.workshopId === workshopId ? { ...m, mapFolder } : m)),
    )
  }

  const handleAddCollectionMods = async () => {
    if (!canManageMods) return
    const selectedModsList = collectionMods.filter((m) => m.selected)

    if (selectedModsList.length === 0) {
      toast({
        title: 'No Mods Selected',
        description: 'Check the mods you want to add from the list above.',
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedModsList.map(async (mod) => {
          const selectedModIds = mod.modId ? [mod.modId] : undefined
          await modsApi.addModAdvanced(
            mod.workshopId,
            selectedModIds,
            !selectedModIds, // includeAllModIds when no explicit modId was set
            mod.name,
            mod.isMap ? mod.mapFolder : undefined,
          )
          return mod.workshopId
        }),
      )

      const added = results.filter((r) => r.status === 'fulfilled').length
      const failed = results.filter((r) => r.status === 'rejected').length
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          reportClientWarning(
            `Failed to add mod ${selectedModsList[index].workshopId}.`,
            result.reason,
          )
        }
      })

      toast({
        title:
          Number(added) === 1
            ? String(added) + ' mod added to server config'
            : String(added) + ' mods added to server config',
        description:
          failed > 0
            ? String(failed) + ' failed — check the console for details'
            : 'Restart the server to load the new mods.',
        variant: failed > 0 ? 'destructive' : ('success' as const),
      })

      setCollectionDialogOpen(false)
      setCollectionMods([])
      setCollectionUrl('')
      fetchData()
    } catch (error) {
      toast({
        title: 'Import Failed',
        description: getUserErrorMessage(
          error,
          'Could not add mods to server config. Try again.',
        ),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleWriteToIni = async () => {
    if (!canManageMods) return
    if (modsToInstall.length === 0) {
      toast({
        title: 'Nothing to Write',
        description: 'Add mods to the pending list first, then write to INI.',
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      const modsData = modsToInstall.map((m) => ({
        workshopId: m.workshopId,
        modId: m.modId || m.workshopId,
      }))

      const mapFolders = modsToInstall
        .filter((m) => m.isMap && m.mapFolder)
        .map((m) => m.mapFolder!)

      const result = await modsApi.writeToIni(modsData, mapFolders)

      const unresolvedIds: string[] = result.unresolvedModIds || []
      const nameByWorkshopId = new Map(
        modsToInstall.map((m) => [m.workshopId, m.name]),
      )
      const unresolvedNames = unresolvedIds.map(
        (id) => nameByWorkshopId.get(id) || id,
      )
      const hasResolvedNames = unresolvedNames.some(
        (name, i) => name !== unresolvedIds[i],
      )

      toast({
        title: 'Configuration Saved',
        description:
          unresolvedIds.length > 0
            ? `${result.message}${hasResolvedNames ? ` (${unresolvedNames.join(', ')})` : ''}`
            : String(result.modsConfigured) +
              ' mods configured. Restart server to apply.',
        variant: unresolvedIds.length > 0 ? 'destructive' : undefined,
      })

      setModsToInstall([])
      fetchData()
    } catch (error) {
      toast({
        title: 'Write to INI Failed',
        description: getUserErrorMessage(
          error,
          'Failed to write configuration',
        ),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleSyncModIds = async () => {
    if (!canManageMods) return
    setSyncing(true)
    try {
      const result = await modsApi.syncModIds()

      const synced =
        result.syncedMods?.filter((m: { status?: string }) =>
          m.status?.startsWith('added'),
        ).length || 0
      const missing = result.missingMods?.length || 0

      if (synced > 0 || missing > 0) {
        toast({
          title: 'Mod IDs Synced',
          description:
            String(synced) +
            ' mod ID(s) added to config.' +
            String(
              missing > 0
                ? ' ' + String(missing) + ' mod(s) not yet downloaded.'
                : '',
            ),
        })
      } else {
        toast({
          title: 'Already Synced',
          description:
            'All downloaded mods are already in the Mods= configuration.',
        })
      }

      fetchData()
    } catch (error) {
      toast({
        title: 'Mod ID Sync Failed',
        description: getUserErrorMessage(error, 'Failed to sync mod IDs'),
        variant: 'destructive',
      })
    } finally {
      setSyncing(false)
    }
  }

  const handleDragStart = (index: number) => {
    setDraggedModIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedModIndex === null || draggedModIndex === index) return
    if (draggedModIndex < 0 || draggedModIndex >= orderedModIds.length) return

    const newOrder = [...orderedModIds]
    const [draggedItem] = newOrder.splice(draggedModIndex, 1)
    newOrder.splice(index, 0, draggedItem)
    setOrderedModIds(newOrder)
    setDraggedModIndex(index)
  }

  const handleDragEnd = () => {
    setDraggedModIndex(null)
  }

  const moveModUp = (index: number) => {
    if (index === 0) return
    const newOrder = [...orderedModIds]
    ;[newOrder[index - 1], newOrder[index]] = [
      newOrder[index],
      newOrder[index - 1],
    ]
    setOrderedModIds(newOrder)
  }

  const moveModDown = (index: number) => {
    if (index === orderedModIds.length - 1) return
    const newOrder = [...orderedModIds]
    ;[newOrder[index], newOrder[index + 1]] = [
      newOrder[index + 1],
      newOrder[index],
    ]
    setOrderedModIds(newOrder)
  }

  const handleAutoSort = () => {
    const requiresByModId = buildRequiresMap(iniConfig?.workshopModMap)
    const result = computeAutoSortedOrder(orderedModIds, requiresByModId)

    if (result.appliedEdges === 0) {
      toast({
        title:
          result.missing.length > 0
            ? 'Nothing to sort by'
            : 'No dependency data',
        description:
          result.missing.length > 0
            ? Number(result.missing.length) === 1
              ? String(result.missing.length) +
                ' declared requirement is not enabled, so none of the enabled mods depend on each other.'
              : String(result.missing.length) +
                ' declared requirements are not enabled, so none of the enabled mods depend on each other.'
            : 'None of the enabled mods declare a "require" in their mod.info, so there is nothing to sort by.',
      })
      return
    }

    if (result.moved.length === 0) {
      toast({
        title: 'Load order already correct',
        description:
          result.cycles.length > 0
            ? Number(result.cycles.length) === 1
              ? 'Every satisfiable dependency already loads first. ' +
                String(result.cycles.length) +
                ' circular dependency cannot be ordered.'
              : 'Every satisfiable dependency already loads first. ' +
                String(result.cycles.length) +
                ' circular dependencies cannot be ordered.'
            : 'All ' +
              String(result.appliedEdges) +
              ' declared dependencies already load before the mods that need them.',
      })
      return
    }

    setAutoSortPreview(result)
  }

  const applyAutoSort = () => {
    if (!autoSortPreview) return
    setOrderedModIds(autoSortPreview.order)
    const movedCount = autoSortPreview.moved.length
    setAutoSortPreview(null)
    toast({
      title: 'Auto-sort applied',
      description:
        Number(movedCount) === 1
          ? String(movedCount) +
            ' mod repositioned. Click Save Order to write it to the server INI.'
          : String(movedCount) +
            ' mods repositioned. Click Save Order to write it to the server INI.',
    })
  }

  const handleSaveModOrder = async () => {
    if (busyRef.current || !canManageMods) return
    if (serverChangedSinceLoad) {
      toast({
        title: 'Active server changed',
        description:
          'The active server changed while the mod order was being edited. Reset the order before saving.',
        variant: 'destructive',
      })
      return
    }
    busyRef.current = true
    try {
      setSavingModOrder(true)
      await modsApi.saveModOrder(orderedModIds)
      setConflicts((prev) =>
        prev ? recalculateConflictWinners(prev, orderedModIds) : prev,
      )
      setScanIniSnapshot(
        createConflictScanSnapshot(iniConfig?.workshopIds, orderedModIds),
      )
      toast({
        title: 'Mod Order Saved',
        description: 'The mod load order has been updated in the server INI.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Save Order Failed',
        description: getUserErrorMessage(error, 'Failed to save mod order'),
        variant: 'destructive',
      })
    } finally {
      setSavingModOrder(false)
      busyRef.current = false
    }
  }

  const promoteModOverOpponent = async (
    winnerModId: string,
    winnerName: string,
    loserModId: string,
    loserName: string,
  ) => {
    if (busyRef.current || !canManageMods) return
    if (serverChangedSinceLoad) {
      toast({
        title: 'Active server changed',
        description:
          'The active server changed while the mod order was being edited. Reset the order before saving.',
        variant: 'destructive',
      })
      return
    }
    const source =
      iniConfig?.modIds && iniConfig.modIds.length > 0
        ? iniConfig.modIds
        : orderedModIds
    const next = [...source]
    const wi = next.indexOf(winnerModId)
    if (wi === -1 || next.indexOf(loserModId) === -1) {
      toast({
        title: 'Cannot reorder',
        description: 'One of these mods is not in the active load order.',
        variant: 'destructive',
      })
      return
    }
    next.splice(wi, 1)
    const newLi = next.indexOf(loserModId)
    next.splice(newLi + 1, 0, winnerModId)

    busyRef.current = true
    try {
      setSavingModOrder(true)
      await modsApi.saveModOrder(next)
      setOrderedModIds(next)
      setConflicts((prev) =>
        prev ? recalculateConflictWinners(prev, next) : prev,
      )
      setScanIniSnapshot(
        createConflictScanSnapshot(iniConfig?.workshopIds, next),
      )
      toast({
        title: 'Load order updated',
        description:
          String(winnerName) + ' now loads after ' + String(loserName) + '.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Could not update load order',
        description: getUserErrorMessage(error, 'Failed to save mod order'),
        variant: 'destructive',
      })
    } finally {
      setSavingModOrder(false)
      busyRef.current = false
    }
  }

  const hasModOrderChanged = useMemo(() => {
    if (!iniConfig?.modIds) return false
    if (orderedModIds.length !== iniConfig.modIds.length) return true
    return orderedModIds.some((id, i) => id !== iniConfig.modIds[i])
  }, [orderedModIds, iniConfig?.modIds])

  useEffect(() => {
    if (!socket) return
    const handleActiveServerChanged = () => {
      if (hasModOrderChanged) {
        setServerChangedSinceLoad(true)
        toast({
          title: 'Active server changed',
          description:
            'The active server changed while the mod order was being edited. Reset the order before saving.',
          variant: 'destructive',
        })
        return
      }
      void fetchData()
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, fetchData, hasModOrderChanged, toast])

  useEffect(() => {
    if (serverChangedSinceLoad && !hasModOrderChanged) {
      setServerChangedSinceLoad(false)
      void fetchData()
    }
  }, [serverChangedSinceLoad, hasModOrderChanged, fetchData])

  const removeFromInstallList = (workshopId: string) => {
    setModsToInstall((prev) => prev.filter((m) => m.workshopId !== workshopId))
  }

  const openWorkshopPage = (workshopId: string) => {
    window.open(
      `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`,
      '_blank',
      'noopener,noreferrer',
    )
  }

  const toggleModSelect = useCallback((workshopId: string) => {
    setSelectedMods((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(workshopId)) {
        newSet.delete(workshopId)
      } else {
        newSet.add(workshopId)
      }
      return newSet
    })
  }, [])

  const selectAllVisible = () => {
    setSelectedMods(new Set(visibleServerMods.map((mod) => mod.workshop_id)))
  }

  const deselectAll = () => {
    setSelectedMods(new Set())
  }

  const handleSaveRestartSettings = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.setRestartOptions({
        warningMinutes: restartWarningMinutes,
        delayIfPlayersOnline: delayIfPlayersOnline,
        maxDelayMinutes: maxDelayMinutes,
      })
      toast({
        title: 'Settings Saved',
        description: 'Restart options have been updated',
      })
      setRestartSettingsOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: 'Settings Save Failed',
        description: getUserErrorMessage(error, 'Failed to save settings'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleCancelPendingRestart = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.cancelPendingRestart()
      toast({
        title: 'Restart Cancelled',
        description: 'Pending restart has been cancelled',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Cancel Failed',
        description: getUserErrorMessage(error, 'Failed to cancel restart'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const modsWithUpdates = useMemo(
    () => mods.filter((m) => m.update_available),
    [mods],
  )
  const selectedCollectionCount = useMemo(
    () => collectionMods.filter((m) => m.selected).length,
    [collectionMods],
  )

  const renderModRow = useCallback(
    (mod: TrackedMod) => {
      const isSelected = selectedMods.has(mod.workshop_id)
      const inConfig = configuredWorkshopIds.has(mod.workshop_id)
      const anySelected = selectedMods.size > 0
      const label = mod.name || 'Mod ' + String(mod.workshop_id)
      const revealClass =
        isSelected || anySelected
          ? 'opacity-100'
          : 'opacity-0 group-hover/modrow:opacity-100 focus-within:opacity-100'
      return (
        <ModRow
          key={mod.id}
          selected={isSelected}
          leading={
            <div className="flex items-center gap-3">
              <div className={`transition-opacity ${revealClass}`}>
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => toggleModSelect(mod.workshop_id)}
                  aria-label={`Select ${label}`}
                />
              </div>
              <WorkshopThumb
                wsId={mod.workshop_id}
                label={label}
                demo={demoMode}
                tone={
                  mod.update_available
                    ? 'border-warning/40 bg-warning/10 text-warning'
                    : !mod.last_checked
                      ? 'border-border/50 bg-muted/30 text-muted-foreground'
                      : 'border-primary/25 bg-primary/[0.06] text-primary/85'
                }
                fallbackIcon={
                  <Package className="h-8 w-8" aria-hidden="true" />
                }
              />
            </div>
          }
          title={
            <span
              className={`truncate text-sm ${mod.update_available ? 'font-semibold text-foreground' : 'font-medium text-foreground/95'}`}
            >
              {label}
            </span>
          }
          titleBadges={
            <>
              {!inConfig && (
                <Badge
                  variant="outline"
                  className="h-5 shrink-0 border-destructive/40 bg-destructive/5 text-[10px] text-destructive"
                >
                  {'Not in Config'}
                </Badge>
              )}
              {mod.update_available ? (
                <Badge
                  variant="warning"
                  className="update-badge-pulse h-5 shrink-0 gap-1 text-[10px]"
                >
                  <span
                    className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning"
                    aria-hidden="true"
                  />
                  {'Update'}
                </Badge>
              ) : null}
            </>
          }
          meta={
            <>
              <WorkshopIdChip
                wsId={mod.workshop_id}
                onCopied={(id) =>
                  toast({
                    title: 'Copied',
                    description: 'Workshop ID ' + String(id),
                  })
                }
              />
              {mod.last_checked ? (
                <span>
                  {'Checked ' +
                    String(new Date(mod.last_checked).toLocaleDateString('en'))}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded border border-dashed border-muted-foreground/30 bg-muted/20 px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                  <span
                    className="inline-block h-1 w-1 rounded-full bg-muted-foreground/60"
                    aria-hidden="true"
                  />
                  {'Unchecked'}
                </span>
              )}
            </>
          }
          actions={
            <div
              className={`flex items-center gap-0.5 transition-opacity ${revealClass}`}
            >
              <WorkshopLinkAction
                wsId={mod.workshop_id}
                label={label}
                hint={'Open Workshop Page'}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="iconDense"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmRemoveMod(mod.workshop_id)}
                    disabled={loading}
                    aria-label={'Remove mod ' + String(label)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{'Remove from server'}</TooltipContent>
              </Tooltip>
            </div>
          }
        />
      )
    },
    [
      demoMode,
      selectedMods,
      configuredWorkshopIds,
      loading,
      toggleModSelect,
      toast,
      'en',
    ],
  )

  type ModGroup = 'update' | 'neverChecked' | 'upToDate' | 'deactivated'
  type FlatModItem =
    | { type: 'header'; group: ModGroup; count: number }
    | { type: 'hint' }
    | { type: 'mod'; mod: TrackedMod; group: ModGroup }

  const modListRef = useRef<HTMLDivElement>(null)

  const flatModItems = useMemo<FlatModItem[]>(() => {
    const items: FlatModItem[] = []
    if (groupedMods.updateAvailable.length > 0) {
      items.push({
        type: 'header',
        group: 'update',
        count: groupedMods.updateAvailable.length,
      })
      for (const mod of groupedMods.updateAvailable)
        items.push({ type: 'mod', mod, group: 'update' })
    }
    if (groupedMods.neverChecked.length > 0) {
      items.push({
        type: 'header',
        group: 'neverChecked',
        count: groupedMods.neverChecked.length,
      })
      if (
        groupedMods.updateAvailable.length === 0 &&
        groupedMods.upToDate.length === 0 &&
        !searchQuery
      ) {
        items.push({ type: 'hint' })
      }
      if (neverCheckedExpanded) {
        for (const mod of groupedMods.neverChecked)
          items.push({ type: 'mod', mod, group: 'neverChecked' })
      }
    }
    if (groupedMods.upToDate.length > 0) {
      items.push({
        type: 'header',
        group: 'upToDate',
        count: groupedMods.upToDate.length,
      })
      if (upToDateExpanded) {
        for (const mod of groupedMods.upToDate)
          items.push({ type: 'mod', mod, group: 'upToDate' })
      }
    }
    return items
  }, [groupedMods, searchQuery, upToDateExpanded, neverCheckedExpanded])

  const modListVirtualizer = useVirtualizer({
    count: flatModItems.length,
    getScrollElement: () => modListRef.current,
    estimateSize: (i) =>
      flatModItems[i].type === 'mod'
        ? 96
        : flatModItems[i].type === 'hint'
          ? 48
          : 40,
    overscan: 10,
  })

  const activeModsData = useMemo(() => {
    const wsMap = iniConfig?.workshopModMap || {}
    const groups: WsGroup[] = []
    for (const wsId of iniConfig?.workshopIds || []) {
      const details = wsMap[wsId] || []
      if (details.length === 0) continue
      groups.push({
        wsId,
        mods: details,
        allEnabled: details.every((m) => m.enabled),
        someEnabled: details.some((m) => m.enabled),
      })
    }
    const allModsList = groups.flatMap((g) => g.mods)
    const mappedIds = new Set(allModsList.map((m) => m.id))
    const enabledIds = new Set(
      allModsList.filter((m) => m.enabled).map((m) => m.id),
    )
    const orphaned = (iniConfig?.modIds || []).filter(
      (id) => !mappedIds.has(id),
    )
    for (const id of orphaned) enabledIds.add(id)
    const enabledCount = enabledIds.size
    const multiIdCount = groups.filter((g) => g.mods.length > 1).length

    const resolveRequirement = createRequirementResolver(enabledIds)
    const isRequireSatisfied = (req: string) => resolveRequirement(req) !== null
    const missingDepsMap = new Map<string, string[]>()
    for (const g of groups) {
      for (const mod of g.mods) {
        if (!mod.require?.length || !mod.enabled) continue
        const missing = mod.require.filter((r) => !isRequireSatisfied(r))
        if (missing.length > 0) missingDepsMap.set(mod.id, missing)
      }
    }

    const modIdProviders = new Map<string, string[]>()
    for (const g of groups) {
      for (const mod of g.mods) {
        const list = modIdProviders.get(mod.id) || []
        list.push(g.wsId)
        modIdProviders.set(mod.id, list)
      }
    }
    const duplicateModIds = new Map<string, string[]>()
    for (const [modId, wsIds] of modIdProviders) {
      if (wsIds.length > 1) duplicateModIds.set(modId, wsIds)
    }

    return {
      groups,
      orphaned,
      enabledCount,
      multiIdCount,
      missingDepsMap,
      duplicateModIds,
    }
  }, [iniConfig?.workshopModMap, iniConfig?.workshopIds, iniConfig?.modIds])

  const ignoredPairKeys = useMemo(() => {
    const s = new Set<string>()
    for (const p of ignoredPairs) {
      const a = p.mod_a,
        b = p.mod_b
      s.add(a < b ? `${a}--${b}` : `${b}--${a}`)
    }
    return s
  }, [ignoredPairs])
  const isPairIgnored = useCallback(
    (a: string, b: string) => {
      return ignoredPairKeys.has(a < b ? `${a}--${b}` : `${b}--${a}`)
    },
    [ignoredPairKeys],
  )
  const siblingConflictsMap = useMemo(() => {
    const result = new Map<string, Map<string, Set<string>>>()
    if (!conflicts?.pairs?.length) return result
    const modToWs = new Map<string, string>()
    for (const g of activeModsData.groups) {
      for (const m of g.mods) modToWs.set(m.id, g.wsId)
    }
    for (const pair of conflicts.pairs) {
      const wsA = modToWs.get(pair.modA.modId)
      const wsB = modToWs.get(pair.modB.modId)
      if (!wsA || wsA !== wsB) continue
      if (isPairIgnored(pair.modA.modId, pair.modB.modId)) continue
      let groupMap = result.get(wsA)
      if (!groupMap) {
        groupMap = new Map()
        result.set(wsA, groupMap)
      }
      const setA = groupMap.get(pair.modA.modId) || new Set<string>()
      setA.add(pair.modB.modId)
      groupMap.set(pair.modA.modId, setA)
      const setB = groupMap.get(pair.modB.modId) || new Set<string>()
      setB.add(pair.modA.modId)
      groupMap.set(pair.modB.modId, setB)
    }
    return result
  }, [conflicts?.pairs, activeModsData, isPairIgnored])

  const activeModsFiltered = useMemo(() => {
    const { groups } = activeModsData
    const q = deferredModManagerSearch.toLowerCase().trim()
    const filteredGroups = groups
      .map((g) => {
        if (!q) return g
        const matchesWs = g.wsId.includes(q)
        if (matchesWs) return g
        const matched = g.mods.filter(
          (m) =>
            m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
        )
        if (matched.length === 0) return null
        return { ...g, mods: matched }
      })
      .filter((g): g is WsGroup => g !== null)
    return { filteredGroups }
  }, [activeModsData, deferredModManagerSearch])

  const scanConflicts = useCallback(async () => {
    if (eventSourceRef.current) {
      closingIntentionallyRef.current = true
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    closingIntentionallyRef.current = false

    setConflictsLoading(true)
    setScanProgress(0)
    setScanCurrentMod(null)
    setScanModsScanned(0)
    setScanTotalMods(0)
    setStreamConflicts([])
    cancelAnimationFrame(scanBatchRef.current.raf)
    scanBatchRef.current = {
      progress: 0,
      modName: null,
      modsScanned: 0,
      dirty: false,
      raf: 0,
    }

    const token = getAccessToken()
    const url = `/api/mods/conflicts/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const es = new EventSource(url)
    eventSourceRef.current = es

    const resetIdleTimer = () => {
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      sseIdleTimerRef.current = setTimeout(() => {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        setConflictsError('Scan timed out — no response from server')
        setConflictsLoading(false)
      }, 90_000)
    }
    resetIdleTimer()

    es.addEventListener('init', (e) => {
      resetIdleTimer()
      try {
        const data = JSON.parse(e.data)
        setConflictsError(null)
        setScanTotalMods(data.totalWorkshopIds || 0)
      } catch (err) {
        reportClientWarning('SSE init parse error.', err)
      }
    })

    es.addEventListener('mod-scanned', (e) => {
      resetIdleTimer()
      try {
        const data: ScanStreamModScanned = JSON.parse(e.data)
        const batch = scanBatchRef.current
        batch.progress = data.progress
        batch.modName = data.modName
        batch.modsScanned = data.modsScanned
        if (!batch.dirty) {
          batch.dirty = true
          batch.raf = requestAnimationFrame(() => {
            setScanProgress(batch.progress)
            setScanCurrentMod(batch.modName)
            setScanModsScanned(batch.modsScanned)
            batch.dirty = false
          })
        }
      } catch (err) {
        reportClientWarning('SSE mod-scanned parse error.', err)
      }
    })

    es.addEventListener('conflict-found', (e) => {
      resetIdleTimer()
      try {
        const data: ScanStreamConflictFound = JSON.parse(e.data)
        setStreamConflicts((prev) => {
          const next = [...prev, data]
          return next.length > 50 ? next.slice(-50) : next
        })
      } catch (err) {
        reportClientWarning('SSE conflict-found parse error.', err)
      }
    })

    es.addEventListener('phase', (e) => {
      resetIdleTimer()
      try {
        const data = JSON.parse(e.data)
        setScanProgress(data.progress)
        if (data.phase === 'hashing')
          setScanCurrentMod('Comparing file contents...')
        if (data.phase === 'grouping') setScanCurrentMod('Grouping results...')
      } catch (err) {
        reportClientWarning('SSE phase parse error.', err)
      }
    })

    es.addEventListener('complete', (e) => {
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      try {
        const data = JSON.parse((e as MessageEvent).data)
        cancelAnimationFrame(scanBatchRef.current.raf)
        scanBatchRef.current.dirty = false
        setConflicts(data)
        setLastScanTime(new Date())
        setScanIniSnapshot(
          createConflictScanSnapshot(iniConfig?.workshopIds, iniConfig?.modIds),
        )
        setScanProgress(100)
      } catch (err) {
        setConflictsError('Failed to parse scan results')
      } finally {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        setConflictsLoading(false)
      }
    })

    es.addEventListener('error', (e) => {
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      es.close()
      if (eventSourceRef.current === es) eventSourceRef.current = null

      if (closingIntentionallyRef.current) {
        closingIntentionallyRef.current = false
        setConflictsLoading(false)
        return
      }

      const me = e as MessageEvent
      if (typeof me.data === 'string') {
        try {
          const data = JSON.parse(me.data)
          setConflictsError(data.error || 'Scan failed')
        } catch {
          setConflictsError('Scan connection lost')
        }
        setConflictsLoading(false)
        toast({
          title: 'Scan Failed',
          description: 'Lost connection to scan stream',
          variant: 'destructive',
        })
      } else {
        setConflictsLoading(false)
        modsApi
          .getCachedConflicts()
          .then((cached) => {
            if (closingIntentionallyRef.current) return
            if (cached) {
              setConflicts(cached)
              setConflictsError(
                'Scan disconnected — showing previously cached results.',
              )
            } else {
              setConflictsError('Scan connection lost')
              toast({
                title: 'Scan Failed',
                description: 'Lost connection to scan stream',
                variant: 'destructive',
              })
            }
          })
          .catch(() => {
            if (closingIntentionallyRef.current) return
            setConflictsError('Scan connection lost')
            toast({
              title: 'Scan Failed',
              description: 'Lost connection to scan stream',
              variant: 'destructive',
            })
          })
      }
    })
  }, [toast, iniConfig?.workshopIds, iniConfig?.modIds])

  useEffect(() => {
    if (!reviewUnresolved || reviewDeepLinkStarted.current) return

    reviewDeepLinkStarted.current = true
    if (!conflicts && !conflictsLoading) void scanConflicts()
  }, [reviewUnresolved, conflicts, conflictsLoading, scanConflicts])

  return (
    <TooltipProvider>
      <div className="space-y-6 page-transition">
        {fetchError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{'Mod data could not be loaded'}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words" dir="auto">
                {fetchError}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchData}
                className="self-start"
              >
                <RefreshCw className="me-2 h-4 w-4" /> {'Retry'}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <PageHeader
          title={'Mod Manager'}
          description={
            'Add, update, and configure Steam Workshop mods on your server'
          }
          eyebrow={'Workshop'}
          tone="maintain"
          icon={<Package className="w-5 h-5" />}
          actions={
            <Button
              onClick={() => setAdvancedAddOpen(true)}
              className="gap-2"
              variant="command"
            >
              <Plus className="w-4 h-4" />
              {'Add Mod'}
            </Button>
          }
        />

        {permissionDenied ? (
          <EmptyState
            type="accessDenied"
            icon={
              <ShieldAlert className="h-14 w-14 text-muted-foreground/40" />
            }
            title={"You can't view mods"}
            description={
              'Your account\'s role doesn\'t include "Manage mods". Ask an administrator to grant it if you need access to this page.'
            }
          />
        ) : (
          <>
            {(status?.totalModsTracked || 0) > 0 && (
              <div className="flex items-center gap-4 rounded-lg border border-border/50 bg-card/60 px-3 py-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Package className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {String(status?.totalModsTracked || 0) + ' on server'}
                  </span>
                </div>
                <Separator orientation="vertical" className="h-4" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-2 cursor-help">
                      <Layers className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-sm font-medium">
                        {String(iniConfig?.workshopIds?.length || 0) +
                          ' in config'}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {String(iniConfig?.workshopIds?.length || 0) +
                        ' workshop items in WorkshopItems='}
                    </p>
                    <p className="text-muted-foreground">
                      {String(iniConfig?.totalMods || 0) +
                        ' mod IDs in Mods= (some mods register multiple IDs)'}
                    </p>
                  </TooltipContent>
                </Tooltip>
                {modsWithUpdates.length > 0 && (
                  <>
                    <Separator orientation="vertical" className="h-4" />
                    <div className="flex items-center gap-2 text-warning">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span className="text-sm font-medium">
                        {Number(modsWithUpdates.length) === 1
                          ? String(modsWithUpdates.length) + ' update'
                          : String(modsWithUpdates.length) + ' updates'}
                      </span>
                    </div>
                  </>
                )}

                {!status?.workshopAcfConfigured && (
                  <>
                    <Separator orientation="vertical" className="h-4" />
                    <div
                      className="flex min-w-0 items-center gap-2 text-destructive"
                      role="status"
                    >
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span className="text-xs">{'Workshop path missing'}</span>
                      <DisabledReason
                        reason={
                          !canManageServers
                            ? 'Your role does not have permission to manage servers.'
                            : null
                        }
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 border-destructive/30 px-2 text-xs text-foreground hover:bg-destructive/10"
                          onClick={handleOpenWorkshopBrowser}
                          disabled={savingWorkshopPath || !canManageServers}
                        >
                          <FolderOpen className="me-1.5 h-3.5 w-3.5" />
                          {'Fix path'}
                        </Button>
                      </DisabledReason>
                    </div>
                  </>
                )}

                <div className="ms-auto flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-[44px] sm:min-h-0"
                        onClick={handleSyncFromServer}
                        disabled={loading || !canManageMods}
                      >
                        <Download className="w-3.5 h-3.5 me-1.5" />
                        {'Sync'}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {'Sync tracked mods from server INI config'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-[44px] sm:min-h-0"
                        onClick={handleCheckUpdates}
                        disabled={checking || !canManageMods}
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 me-1.5 ${checking ? 'animate-spin' : ''}`}
                        />
                        {'Check Updates'}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {status?.lastCheck ? (
                        (() => {
                          const secs = Math.round(
                            (Date.now() -
                              new Date(status.lastCheck).getTime()) /
                              1000,
                          )
                          let when: string
                          if (secs < 60)
                            when = String(String(secs) + 's') + ' ago'
                          else if (secs < 3600)
                            when =
                              String(String(Math.floor(secs / 60)) + 'm') +
                              ' ago'
                          else if (secs < 86400)
                            when =
                              String(String(Math.floor(secs / 3600)) + 'h') +
                              ' ago'
                          else
                            when = new Date(
                              status.lastCheck,
                            ).toLocaleDateString('en')
                          return <span>{'Last checked ' + String(when)}</span>
                        })()
                      ) : (
                        <span>{'Never checked'}</span>
                      )}
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        aria-label={'More actions'}
                      >
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DisabledReason
                        reason={
                          !canManageMods
                            ? 'Your role does not have permission to manage mods.'
                            : null
                        }
                        className="w-full"
                      >
                        <DropdownMenuItem
                          onClick={() => {
                            if (!canManageMods) return
                            setCollectionDialogOpen(true)
                          }}
                          disabled={!canManageMods}
                        >
                          <Library className="w-4 h-4 me-2" />
                          {'Import Collection'}
                        </DropdownMenuItem>
                      </DisabledReason>
                      <DisabledReason
                        reason={
                          !canManageMods
                            ? 'Your role does not have permission to manage mods.'
                            : null
                        }
                        className="w-full"
                      >
                        <DropdownMenuItem
                          onClick={() => {
                            if (!canManageMods) return
                            setRestartSettingsOpen(true)
                          }}
                          disabled={!canManageMods}
                        >
                          <Settings2 className="w-4 h-4 me-2" />
                          {'Auto-Restart Settings'}
                        </DropdownMenuItem>
                      </DisabledReason>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-sm">{'Auto-restart'}</span>
                          <DisabledReason
                            reason={
                              !canManageMods
                                ? 'Your role does not have permission to manage mods.'
                                : null
                            }
                          >
                            <Switch
                              checked={status?.autoRestartEnabled || false}
                              onCheckedChange={handleToggleAutoRestart}
                              disabled={loading || !canManageMods}
                              aria-label={'Toggle auto-restart on mod update'}
                            />
                          </DisabledReason>
                        </div>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )}

            {status?.pendingRestart && (
              <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3 sm:items-center">
                  <Clock className="w-5 h-5 animate-pulse text-warning" />
                  <div>
                    <p className="font-medium text-warning">
                      {'Restart Pending'}
                    </p>

                    <FolderBrowser
                      open={workshopBrowserOpen}
                      onOpenChange={setWorkshopBrowserOpen}
                      onSelect={handleWorkshopFolderSelected}
                      initialPath={workshopBrowserInitialPath}
                      title={'Choose Project Zomboid server folder'}
                    />
                    <p className="text-xs text-muted-foreground">
                      {'Waiting for players to leave before restarting (max ' +
                        String(status.maxDelayMinutes) +
                        ' min)'}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancelPendingRestart}
                  disabled={loading || !canManageMods}
                  aria-label={'Cancel pending restart'}
                >
                  {'Cancel'}
                </Button>
              </div>
            )}

            {!status?.pendingRestart &&
              (status?.updatesAvailable ?? 0) > 0 &&
              groupedMods.updateAvailable.length === 0 &&
              !checking && (
                <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3 sm:items-center">
                    <AlertTriangle className="w-5 h-5 text-warning" />
                    <div>
                      <p className="font-medium text-warning">
                        {Number(status?.updatesAvailable) === 1
                          ? String(status?.updatesAvailable) +
                            ' mod update reported by Steam — flags out of sync'
                          : String(status?.updatesAvailable) +
                            ' mod updates reported by Steam — flags out of sync'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {
                          'The Workshop folder shows newer files than the panel has on record. Run a check to update the per-mod state.'
                        }
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="warning"
                    size="sm"
                    onClick={handleCheckUpdates}
                    disabled={loading || checking || !canManageMods}
                  >
                    <RefreshCw
                      className={`w-4 h-4 me-2 ${checking ? 'animate-spin' : ''}`}
                    />
                    {'Check Now'}
                  </Button>
                </div>
              )}

            {removedWorkshopMods.length > 0 && (
              <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 shadow-sm">
                <div className="flex items-start gap-3">
                  <Trash2 className="w-5 h-5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-warning">
                      {Number(removedWorkshopMods.length) === 1
                        ? String(removedWorkshopMods.length) +
                          ' mod no longer exists on the Steam Workshop'
                        : String(removedWorkshopMods.length) +
                          ' mods no longer exist on the Steam Workshop'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {
                        'Steam confirmed these items were deleted or made private. They will keep failing update checks and can break the next server restart until removed.'
                      }
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {removedWorkshopMods.map((m) => (
                        <span
                          key={m.workshopId}
                          className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-background/60 py-1 ps-2 pe-1 text-xs"
                        >
                          <span
                            className="max-w-[16rem] truncate"
                            title={m.name || m.workshopId}
                          >
                            {m.name || m.workshopId}
                          </span>
                          <DisabledReason
                            reason={
                              !canManageMods
                                ? 'Your role does not have permission to manage mods.'
                                : null
                            }
                          >
                            <button
                              type="button"
                              onClick={() => setConfirmRemoveMod(m.workshopId)}
                              disabled={loading || !canManageMods}
                              aria-label={
                                'Remove ' +
                                String(m.name || m.workshopId) +
                                ' from the server'
                              }
                              className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-50"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </DisabledReason>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {status &&
              !status.steamApiHealthy &&
              status.lastSteamApiFailureAt &&
              steamApiIssueDismissed !== status.lastSteamApiFailureAt && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <CloudOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                  <span className="min-w-0">
                    {
                      "Steam Workshop couldn't be reached on the last check — using local files only for now. Will retry automatically."
                    }
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const since = status.lastSteamApiFailureAt
                      if (!since) return
                      try {
                        localStorage.setItem(
                          STEAM_API_ISSUE_DISMISSED_KEY,
                          since,
                        )
                      } catch {
                        /* ignore storage failures */
                      }
                      setSteamApiIssueDismissed(since)
                    }}
                    aria-label={'Dismiss Steam API warning'}
                    title={'Dismiss until the next failed check'}
                    className="ms-auto shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}

            {(status?.unknownWorkshopIds?.length ?? 0) > 0 && (
              <div className="flex flex-wrap items-start gap-2 px-1 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                <span>
                  {Number(status!.unknownWorkshopIds.length) === 1
                    ? String(status!.unknownWorkshopIds.length) +
                      ' item got an unrecognized response from Steam this check:'
                    : String(status!.unknownWorkshopIds.length) +
                      ' items got an unrecognized response from Steam this check:'}{' '}
                  {status!.unknownWorkshopIds
                    .map(
                      (item) =>
                        String(item.id) +
                        ' (code ' +
                        String(item.resultCode) +
                        ')',
                    )
                    .join(', ')}
                </span>
              </div>
            )}

            {iniConfig?.duplicateKeys && iniConfig.duplicateKeys.length > 0 && (
              <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3 sm:items-center">
                  <AlertTriangle className="w-5 h-5 text-warning" />
                  <div>
                    <p className="font-medium text-warning">
                      {Number(iniConfig.duplicateKeys.length) === 1
                        ? '"' +
                          String(
                            iniConfig.duplicateKeys
                              .map((d) => d.key)
                              .join(', '),
                          ) +
                          '" appears more than once in this configuration file'
                        : String(iniConfig.duplicateKeys.length) +
                          ' settings appear more than once in this configuration file: ' +
                          String(
                            iniConfig.duplicateKeys
                              .map((d) => d.key)
                              .join(', '),
                          )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {
                        'This page reads the first copy and the Server Configuration editor reads the last, so the two can show different values for the same setting.'
                      }
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-[236px_minmax(0,1fr)]">
              <nav
                aria-label={'Mod management sections'}
                className="space-y-4 lg:sticky lg:top-4 lg:self-start"
              >
                {MODS_NAV.map((section) => (
                  <div key={section.group}>
                    <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
                      {section.group}
                    </p>
                    <div className="space-y-0.5">
                      {section.items.map((item) => {
                        const isActive = activeTab === item.id
                        const count =
                          item.id === 'deactivated'
                            ? groupedMods.deactivated.length
                            : null
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-current={isActive ? 'true' : undefined}
                            title={item.hint}
                            onClick={() => {
                              setActiveTab(item.id)
                              if (CONFIG_VIEWS.includes(item.id)) {
                                setConfigSubTab(
                                  item.id as
                                    | 'active'
                                    | 'order'
                                    | 'add'
                                    | 'presets'
                                    | 'tools',
                                )
                              }
                              if (
                                item.id === 'conflicts' &&
                                !conflicts &&
                                !conflictsLoading
                              )
                                void scanConflicts()
                            }}
                            className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-start transition-colors ${
                              isActive
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                            }`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5 text-sm font-medium">
                                <span className="truncate">{item.label}</span>
                                {item.id === 'order' && hasModOrderChanged && (
                                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                                )}
                                {count != null && count > 0 && (
                                  <span
                                    className={`ms-auto shrink-0 rounded-full px-1.5 font-mono text-[10px] tabular-nums ${
                                      isActive
                                        ? 'bg-primary-foreground/20'
                                        : 'bg-muted-foreground/20'
                                    }`}
                                  >
                                    {count}
                                  </span>
                                )}
                              </span>
                              <span
                                className={`mt-0.5 block text-[11px] leading-snug ${
                                  isActive
                                    ? 'text-primary-foreground/75'
                                    : 'text-muted-foreground/70'
                                }`}
                              >
                                {item.hint}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </nav>

              <div className="min-w-0 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">
                      {
                        MODS_NAV.flatMap((s) => s.items).find(
                          (i) => i.id === activeTab,
                        )?.label
                      }
                    </h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {
                        MODS_NAV.flatMap((s) => s.items).find(
                          (i) => i.id === activeTab,
                        )?.hint
                      }
                    </p>
                  </div>

                  <Dialog
                    open={collectionDialogOpen}
                    onOpenChange={(open) => {
                      setCollectionDialogOpen(open)
                      if (!open) {
                        setShowCollectionAdvanced(false)
                        setCollectionImported(false)
                        setCollectionUrl('')
                        setCollectionMods([])
                      }
                    }}
                  >
                    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto sm:max-h-[80vh]">
                      <DialogHeader>
                        <DialogTitle>
                          {'Import Steam Workshop Collection'}
                        </DialogTitle>
                        <DialogDescription>
                          {
                            'Paste a collection URL to add all its mods to your server config at once'
                          }
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="collection-url-input">
                              {'Collection URL or ID'}
                            </Label>
                            <HelpTip label={'Collection URL or ID'}>
                              {
                                "A Collection is a curated list of multiple mods bundled together by its creator. Paste the collection's own URL or numeric ID here — a single mod's Workshop page won't work. To add just one mod, use Add Mod instead."
                              }
                            </HelpTip>
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                              id="collection-url-input"
                              value={collectionUrl}
                              onChange={(e) => setCollectionUrl(e.target.value)}
                              placeholder={
                                'https://steamcommunity.com/sharedfiles/filedetails/?id=...'
                              }
                              maxLength={200}
                              autoFocus
                            />
                            <DisabledReason
                              reason={
                                !canManageMods
                                  ? 'Your role does not have permission to manage mods.'
                                  : null
                              }
                            >
                              <Button
                                onClick={handleImportCollection}
                                disabled={importingCollection || !canManageMods}
                                className="w-full sm:w-auto"
                              >
                                {importingCollection ? (
                                  <RefreshCw className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4" />
                                )}
                              </Button>
                            </DisabledReason>
                          </div>
                        </div>

                        {collectionImported &&
                          collectionMods.length === 0 &&
                          !importingCollection && (
                            <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning">
                              <AlertTriangle className="w-4 h-4 shrink-0" />
                              {
                                'No mods found in this collection. Check the URL and try again.'
                              }
                            </div>
                          )}

                        {collectionMods.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <Label>
                                {'Found ' +
                                  String(collectionMods.length) +
                                  ' mods'}
                              </Label>
                              <div className="flex gap-2 flex-wrap justify-end">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    setShowCollectionAdvanced(
                                      !showCollectionAdvanced,
                                    )
                                  }
                                >
                                  {showCollectionAdvanced
                                    ? 'Hide Advanced Fields'
                                    : 'Edit IDs and Maps'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    setCollectionMods((prev) =>
                                      prev.map((m) => ({
                                        ...m,
                                        selected: true,
                                      })),
                                    )
                                  }
                                >
                                  {'Select All'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    setCollectionMods((prev) =>
                                      prev.map((m) => ({
                                        ...m,
                                        selected: false,
                                      })),
                                    )
                                  }
                                >
                                  {'Deselect All'}
                                </Button>
                              </div>
                            </div>
                            <ScrollArea className="h-[min(48vh,22rem)] border rounded-lg p-2 sm:h-[min(52vh,24rem)]">
                              <div className="space-y-2">
                                {collectionMods.map((mod) => {
                                  const alreadyInstalled =
                                    iniConfig?.workshopIds?.includes(
                                      mod.workshopId,
                                    )
                                  return (
                                    <div
                                      key={mod.workshopId}
                                      className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${mod.selected ? 'border-primary/30 bg-primary/10' : 'bg-card/60 hover:bg-accent/20'}`}
                                    >
                                      <Checkbox
                                        checked={mod.selected}
                                        onCheckedChange={() =>
                                          toggleModSelection(mod.workshopId)
                                        }
                                        aria-label={
                                          'Select ' + String(mod.name)
                                        }
                                      />
                                      <div className="flex-1 space-y-1 min-w-0">
                                        <div className="flex items-center gap-2 min-w-0">
                                          <span className="font-medium text-sm truncate">
                                            {mod.name}
                                          </span>
                                          {alreadyInstalled && (
                                            <Badge
                                              variant="outline"
                                              className="text-xs text-muted-foreground"
                                            >
                                              {'Installed'}
                                            </Badge>
                                          )}
                                          {mod.isMap && (
                                            <Badge
                                              variant="secondary"
                                              className="text-xs"
                                            >
                                              <MapIcon className="w-3 h-3 me-1" />
                                              {'Map'}
                                            </Badge>
                                          )}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                          {'ID: ' + String(mod.workshopId)}
                                        </p>
                                        {mod.selected &&
                                          showCollectionAdvanced && (
                                            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                              <div>
                                                <Label
                                                  className="text-xs"
                                                  htmlFor={`collection-mod-id-${mod.workshopId}`}
                                                >
                                                  {'Mod ID'}
                                                </Label>
                                                <Input
                                                  id={`collection-mod-id-${mod.workshopId}`}
                                                  value={mod.modId || ''}
                                                  onChange={(e) =>
                                                    updateModId(
                                                      mod.workshopId,
                                                      e.target.value,
                                                    )
                                                  }
                                                  placeholder={'From info.txt'}
                                                  maxLength={200}
                                                  className="h-7 text-xs"
                                                />
                                              </div>
                                              {mod.isMap && (
                                                <div>
                                                  <Label
                                                    className="text-xs"
                                                    htmlFor={`collection-map-folder-${mod.workshopId}`}
                                                  >
                                                    {'Map Folder'}
                                                  </Label>
                                                  <Input
                                                    id={`collection-map-folder-${mod.workshopId}`}
                                                    value={mod.mapFolder || ''}
                                                    onChange={(e) =>
                                                      updateMapFolder(
                                                        mod.workshopId,
                                                        e.target.value,
                                                      )
                                                    }
                                                    placeholder={
                                                      'MapFolderName'
                                                    }
                                                    maxLength={200}
                                                    className="h-7 text-xs"
                                                  />
                                                </div>
                                              )}
                                            </div>
                                          )}
                                      </div>
                                      <Button
                                        size="iconDense"
                                        variant="ghost"
                                        className="h-10 w-10 sm:h-10 sm:w-10"
                                        onClick={() =>
                                          openWorkshopPage(mod.workshopId)
                                        }
                                        aria-label={
                                          'Open workshop page (opens in new tab)'
                                        }
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                      </Button>
                                    </div>
                                  )
                                })}
                              </div>
                            </ScrollArea>
                          </div>
                        )}
                      </div>
                      <DialogFooter>
                        <Button
                          variant="outline"
                          onClick={() => setCollectionDialogOpen(false)}
                        >
                          {'Cancel'}
                        </Button>
                        <DisabledReason
                          reason={
                            !canManageMods
                              ? 'Your role does not have permission to manage mods.'
                              : null
                          }
                        >
                          <Button
                            onClick={handleAddCollectionMods}
                            disabled={
                              loading ||
                              selectedCollectionCount === 0 ||
                              !canManageMods
                            }
                          >
                            {loading
                              ? 'Adding...'
                              : 'Add ' +
                                String(selectedCollectionCount) +
                                ' Mods to Server'}
                          </Button>
                        </DisabledReason>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  <Dialog
                    open={advancedAddOpen}
                    onOpenChange={(open) => {
                      setAdvancedAddOpen(open)
                      if (!open) {
                        setAdvancedModInput('')
                        setDiscoveredMod(null)
                        setSelectedModIds(new Set())
                        setShowAdvancedIdSelection(false)
                        lastAutoDiscoverIdRef.current = null
                        if (autoDiscoverTimeoutRef.current) {
                          clearTimeout(autoDiscoverTimeoutRef.current)
                          autoDiscoverTimeoutRef.current = null
                        }
                      }
                    }}
                  >
                    <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto sm:max-h-[80vh]">
                      <DialogHeader>
                        <DialogTitle>{'Add Workshop Mod'}</DialogTitle>
                        <DialogDescription>
                          {'Paste a Steam Workshop URL or ID — or'}{' '}
                          <button
                            type="button"
                            className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded-sm"
                            onClick={() => {
                              setAdvancedAddOpen(false)
                              setCollectionDialogOpen(true)
                            }}
                          >
                            {'import an entire collection'}
                          </button>
                          .
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label
                            htmlFor="advanced-mod-input"
                            className="sr-only"
                          >
                            {'Workshop URL or ID'}
                          </Label>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                              id="advanced-mod-input"
                              value={advancedModInput}
                              onChange={(e) =>
                                handleModInputChange(e.target.value)
                              }
                              placeholder={'Paste Workshop URL or enter ID...'}
                              onKeyDown={(e) =>
                                e.key === 'Enter' &&
                                !discoveringMod &&
                                handleDiscoverMod()
                              }
                              className="font-mono text-sm"
                              maxLength={200}
                            />
                            <Button
                              id="discover-mod-btn"
                              onClick={handleDiscoverMod}
                              disabled={
                                discoveringMod ||
                                !advancedModInput.trim() ||
                                !canManageMods
                              }
                              variant="secondary"
                              className="w-full shrink-0 sm:w-auto"
                            >
                              {discoveringMod ? (
                                <RefreshCw className="w-4 h-4 animate-spin" />
                              ) : (
                                <>
                                  <Search className="w-4 h-4 me-1" />
                                  {'Discover'}
                                </>
                              )}
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {
                              'Example: https://steamcommunity.com/sharedfiles/filedetails/?id=3616536783'
                            }
                          </p>
                        </div>

                        {discoveringMod && (
                          <div className="space-y-3 p-4 border rounded-lg bg-muted/30 animate-pulse">
                            <div className="flex items-start justify-between">
                              <div className="space-y-2 flex-1">
                                <div className="h-4 bg-muted rounded w-3/4" />
                                <div className="h-3 bg-muted rounded w-1/2" />
                              </div>
                              <div className="h-5 bg-muted rounded w-16" />
                            </div>
                            <div className="space-y-1.5">
                              <div className="h-8 bg-muted rounded" />
                              <div className="h-8 bg-muted rounded" />
                            </div>
                          </div>
                        )}

                        {discoveredMod && !discoveringMod && (
                          <div className="space-y-3 p-3 border rounded-lg bg-muted/30">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <h4
                                  className="font-medium text-sm truncate"
                                  title={discoveredMod.name}
                                >
                                  {discoveredMod.name}
                                </h4>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <code className="text-xs text-muted-foreground font-mono">
                                    {discoveredMod.workshopId}
                                  </code>
                                  <button
                                    onClick={() =>
                                      window.open(
                                        `https://steamcommunity.com/sharedfiles/filedetails/?id=${discoveredMod.workshopId}`,
                                        '_blank',
                                        'noopener,noreferrer',
                                      )
                                    }
                                    className="text-xs text-primary hover:underline flex items-center gap-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded-sm"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                    {'View'}
                                  </button>
                                </div>
                              </div>
                              <div className="flex gap-1 shrink-0">
                                {discoveredMod.isMap && (
                                  <Badge
                                    variant="secondary"
                                    className="text-xs h-5"
                                  >
                                    <MapIcon className="w-3 h-3 me-1" />
                                    {'Map'}
                                  </Badge>
                                )}
                                {discoveredMod.isDownloaded ? (
                                  <Badge
                                    variant="success"
                                    className="text-xs h-5"
                                  >
                                    <CheckCircle className="w-3 h-3 me-1" />
                                    {'Downloaded'}
                                  </Badge>
                                ) : (
                                  <Badge
                                    variant="warning"
                                    className="text-xs h-5"
                                  >
                                    <Download className="w-3 h-3 me-1" />
                                    {'Not Downloaded'}
                                  </Badge>
                                )}
                              </div>
                            </div>

                            {discoveredMod.isAlreadyAdded && (
                              <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 p-2 text-xs text-foreground">
                                <Info className="w-4 h-4 text-primary shrink-0" />
                                <span>
                                  {
                                    'Workshop ID is already in your server config'
                                  }
                                </span>
                              </div>
                            )}

                            {discoveredMod.modIds.length > 0 ? (
                              <div className="space-y-2.5">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5">
                                    <Label className="text-xs font-medium">
                                      {discoveredMod.hasMultipleModIds
                                        ? 'Mod IDs (' +
                                          String(selectedModIds.size) +
                                          ' of ' +
                                          String(discoveredMod.modIds.length) +
                                          ' selected)'
                                        : 'Mod ID'}
                                    </Label>
                                    <HelpTip
                                      label={
                                        discoveredMod.hasMultipleModIds
                                          ? 'Mod IDs (' +
                                            String(selectedModIds.size) +
                                            ' of ' +
                                            String(
                                              discoveredMod.modIds.length,
                                            ) +
                                            ' selected)'
                                          : 'Mod ID'
                                      }
                                    >
                                      {
                                        "A Workshop item can register more than one internal Mod ID — the folder name declared in its mod.info, not the Workshop's own numeric ID. Only what's selected here gets added to the server config; leave one out and that part of the mod silently won't load."
                                      }
                                    </HelpTip>
                                  </div>
                                  {discoveredMod.hasMultipleModIds && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs px-2.5"
                                      onClick={() =>
                                        setShowAdvancedIdSelection(
                                          !showAdvancedIdSelection,
                                        )
                                      }
                                    >
                                      {showAdvancedIdSelection
                                        ? 'Hide'
                                        : 'Review IDs'}
                                    </Button>
                                  )}
                                </div>

                                {discoveredMod.hasMultipleModIds &&
                                !showAdvancedIdSelection ? (
                                  <p className="text-xs text-muted-foreground">
                                    {
                                      'New IDs are pre-selected automatically. Open Review IDs to manually adjust selection.'
                                    }
                                  </p>
                                ) : (
                                  <>
                                    {discoveredMod.hasMultipleModIds && (
                                      <div className="flex flex-wrap gap-1.5">
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-7 text-xs px-2.5"
                                          onClick={() => {
                                            const newIds =
                                              discoveredMod.modIds.filter(
                                                (id) =>
                                                  !discoveredMod.alreadyConfigured?.includes(
                                                    id,
                                                  ),
                                              )
                                            setSelectedModIds(new Set(newIds))
                                          }}
                                        >
                                          {'Select New'}
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-7 text-xs px-2.5"
                                          onClick={() => {
                                            if (
                                              selectedModIds.size ===
                                              discoveredMod.modIds.length
                                            ) {
                                              setSelectedModIds(new Set())
                                            } else {
                                              setSelectedModIds(
                                                new Set(discoveredMod.modIds),
                                              )
                                            }
                                          }}
                                        >
                                          {selectedModIds.size ===
                                          discoveredMod.modIds.length
                                            ? 'None'
                                            : 'All'}
                                        </Button>
                                      </div>
                                    )}
                                    <div className="space-y-1 max-h-[50vh] overflow-y-auto rounded-lg border border-border/50 bg-background/50 p-1.5">
                                      {discoveredMod.modIds.map((modId) => {
                                        const isConfigured =
                                          discoveredMod.alreadyConfigured?.includes(
                                            modId,
                                          )
                                        return (
                                          <div
                                            key={modId}
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={selectedModIds.has(
                                              modId,
                                            )}
                                            className={`flex items-center gap-2 px-2.5 py-1.5 rounded cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${
                                              selectedModIds.has(modId)
                                                ? 'bg-primary/10 border-s-2 border-s-primary'
                                                : isConfigured
                                                  ? 'bg-muted/30 opacity-70'
                                                  : 'hover:bg-muted/40'
                                            }`}
                                            onClick={() =>
                                              toggleModIdSelection(modId)
                                            }
                                            onKeyDown={(event) => {
                                              if (
                                                event.key === 'Enter' ||
                                                event.key === ' '
                                              ) {
                                                event.preventDefault()
                                                toggleModIdSelection(modId)
                                              }
                                            }}
                                          >
                                            <Checkbox
                                              checked={selectedModIds.has(
                                                modId,
                                              )}
                                              onCheckedChange={() =>
                                                toggleModIdSelection(modId)
                                              }
                                              aria-label={
                                                'Select mod ID ' + String(modId)
                                              }
                                            />
                                            <code
                                              className="text-xs font-mono flex-1 truncate"
                                              title={modId}
                                            >
                                              {modId}
                                            </code>
                                            {isConfigured && (
                                              <Badge
                                                variant="outline"
                                                className="text-xs h-5 shrink-0 text-muted-foreground"
                                              >
                                                {'Exists'}
                                              </Badge>
                                            )}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
                                <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                                <div>
                                  <p className="font-medium text-warning">
                                    {discoveredMod.isDownloaded
                                      ? 'No mod.info files found'
                                      : 'Mod not yet downloaded'}
                                  </p>
                                  <p className="text-muted-foreground mt-0.5">
                                    {discoveredMod.isDownloaded
                                      ? 'This mod may use an unconventional structure'
                                      : 'Add the Workshop ID and sync after server downloads it'}
                                  </p>
                                </div>
                              </div>
                            )}

                            {discoveredMod.mapFolders.length > 0 && (
                              <div className="flex items-start gap-2 text-xs">
                                <MapIcon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                                <div>
                                  <span className="font-medium">
                                    {'Map folders will be added:'}
                                  </span>
                                  <div className="text-muted-foreground mt-0.5">
                                    {discoveredMod.mapFolders.join(', ')}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <DialogFooter className="flex-col sm:flex-row gap-2">
                        <Button
                          variant="outline"
                          onClick={() => setAdvancedAddOpen(false)}
                          className="w-full sm:order-1 sm:w-auto"
                        >
                          {'Cancel'}
                        </Button>
                        <Button
                          onClick={handleAddModAdvanced}
                          disabled={
                            loading ||
                            !discoveredMod ||
                            discoveringMod ||
                            !canManageMods
                          }
                          className="w-full sm:order-2 sm:w-auto"
                        >
                          {loading ? (
                            <>
                              <RefreshCw className="w-4 h-4 me-2 animate-spin" />
                              {'Adding...'}
                            </>
                          ) : discoveredMod?.modIds.length ? (
                            selectedModIds.size > 0 ? (
                              Number(selectedModIds.size) === 1 ? (
                                'Add ' + String(selectedModIds.size) + ' Mod ID'
                              ) : (
                                'Add ' +
                                String(selectedModIds.size) +
                                ' Mod IDs'
                              )
                            ) : (
                              'Add Workshop ID Only'
                            )
                          ) : discoveredMod ? (
                            'Add Workshop ID'
                          ) : (
                            'Discover First'
                          )}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  <Dialog
                    open={restartSettingsOpen}
                    onOpenChange={setRestartSettingsOpen}
                  >
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{'Auto-Restart Settings'}</DialogTitle>
                        <DialogDescription>
                          {
                            'Configure how the server restarts when mod updates are detected'
                          }
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label htmlFor="restart-warning-minutes">
                            {'Warning Time (minutes)'}
                          </Label>
                          <NumberInput
                            id="restart-warning-minutes"
                            min={0}
                            max={30}
                            value={restartWarningMinutes}
                            onChange={setRestartWarningMinutes}
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            {
                              'How long to wait before restarting after detecting updates'
                            }
                          </p>
                        </div>

                        <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card/65 p-3">
                          <div className="space-y-1">
                            <Label>{'Delay if Players Online'}</Label>
                            <p className="text-xs text-muted-foreground">
                              {
                                'Wait for all players to leave before restarting'
                              }
                            </p>
                          </div>
                          <Switch
                            checked={delayIfPlayersOnline}
                            onCheckedChange={setDelayIfPlayersOnline}
                          />
                        </div>

                        {delayIfPlayersOnline && (
                          <div>
                            <Label htmlFor="restart-max-delay">
                              {'Maximum Delay (minutes)'}
                            </Label>
                            <NumberInput
                              id="restart-max-delay"
                              min={5}
                              max={120}
                              value={maxDelayMinutes}
                              onChange={setMaxDelayMinutes}
                            />
                            <p className="text-xs text-muted-foreground mt-1">
                              {
                                'Force restart after this time even if players are online'
                              }
                            </p>
                          </div>
                        )}

                        <div className="rounded-lg border border-border/70 bg-secondary/40 p-3">
                          <p className="text-sm font-medium mb-2">
                            {'Current Settings'}
                          </p>
                          <div className="text-xs text-muted-foreground space-y-1">
                            <p>
                              {'• Warning time: ' +
                                String(restartWarningMinutes) +
                                ' minutes'}
                            </p>
                            <p>
                              {'• Delay for players: ' +
                                String(delayIfPlayersOnline ? 'Yes' : 'No')}
                            </p>
                            {delayIfPlayersOnline && (
                              <p>
                                {'• Max delay: ' +
                                  String(maxDelayMinutes) +
                                  ' minutes'}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                      <DialogFooter className="flex-col sm:flex-row gap-2">
                        <Button
                          variant="outline"
                          onClick={() => setRestartSettingsOpen(false)}
                          className="w-full sm:w-auto"
                        >
                          {'Cancel'}
                        </Button>
                        <Button
                          onClick={handleSaveRestartSettings}
                          disabled={loading || !canManageMods}
                          className="w-full sm:w-auto"
                        >
                          {loading ? 'Saving...' : 'Save Settings'}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>

                {activeTab === 'installed' && (
                  <div className="space-y-4">
                    {mods.length > 0 && (
                      <div className="flex items-center gap-4 flex-wrap">
                        <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 sm:max-w-sm">
                          <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                          <Input
                            ref={searchInputRef}
                            value={searchQuery}
                            onChange={(e) => handleSearchChange(e.target.value)}
                            placeholder={'Search mods...'}
                            maxLength={200}
                            className="ps-9"
                            aria-label={'Search mods'}
                          />
                        </div>

                        <Button
                          variant={showUpdatesOnly ? 'secondary' : 'outline'}
                          size="sm"
                          onClick={() => setShowUpdatesOnly(!showUpdatesOnly)}
                          aria-pressed={showUpdatesOnly}
                          className={
                            showUpdatesOnly
                              ? 'w-full border-warning/40 bg-warning/15 text-warning hover:bg-warning/25 sm:w-auto'
                              : 'w-full sm:w-auto'
                          }
                        >
                          {showUpdatesOnly ? (
                            <Check className="w-4 h-4 me-2" />
                          ) : (
                            <Filter className="w-4 h-4 me-2" />
                          )}
                          {'Updates Only'}
                        </Button>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant={showDisabled ? 'secondary' : 'outline'}
                              size="sm"
                              onClick={() => {
                                const next = !showDisabled
                                setShowDisabled(next)
                                if (next) fetchDisabled()
                              }}
                              aria-pressed={showDisabled}
                              className="w-full sm:w-auto"
                            >
                              {showDisabled ? (
                                <EyeOff className="w-4 h-4 me-2" />
                              ) : (
                                <Eye className="w-4 h-4 me-2" />
                              )}
                              {showDisabled ? 'Hide disabled' : 'Show disabled'}
                              {showDisabled && disabledMods.length > 0 && (
                                <span className="ms-2 inline-flex items-center justify-center rounded-full bg-muted/40 px-1.5 text-[10px] font-medium tabular-nums">
                                  {disabledMods.length}
                                </span>
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {
                              'Mods downloaded to disk but not enabled in the server INI'
                            }
                          </TooltipContent>
                        </Tooltip>

                        {collectionStatus.configured &&
                          (collectionStatus.error ? (
                            <button
                              type="button"
                              onClick={fetchCollectionStatus}
                              title={
                                'Collection sync error: ' +
                                String(collectionStatus.error)
                              }
                              className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors"
                            >
                              <AlertTriangle className="w-3.5 h-3.5" />
                              {'Collection error'}
                            </button>
                          ) : collectionStatus.inSync ? (
                            <button
                              type="button"
                              onClick={fetchCollectionStatus}
                              title={
                                collectionStatus.title
                                  ? 'In sync with "' +
                                    String(collectionStatus.title) +
                                    '"'
                                  : 'Collection mirrors tracked mods'
                              }
                              className="inline-flex items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/20 transition-colors"
                            >
                              <Check className="w-3.5 h-3.5" />
                              {'Collection in sync'}
                              {collectionStatus.autoSync && (
                                <span className="text-[10px] opacity-70">
                                  {'· auto'}
                                </span>
                              )}
                            </button>
                          ) : collectionStatus.drift > 0 ? (
                            <div className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 ps-2.5 pe-1 py-0.5 text-xs font-medium text-warning">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              <span>
                                {String(collectionStatus.drift) + ' drift'}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={handleCollectionSyncNow}
                                disabled={collectionSyncing || !canManageMods}
                                className="h-6 px-2 ms-1 text-xs hover:bg-warning/20"
                                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint describing what the button does ("Sync tracked mods → Steam Workshop collection"), not why it's disabled; unconditional, no permission text to lose. Triaged 2026-08-27.
                                title={
                                  'Sync tracked mods → Steam Workshop collection'
                                }
                              >
                                {collectionSyncing ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  'Sync'
                                )}
                              </Button>
                            </div>
                          ) : collectionStatus.loading ? (
                            <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              {'Checking collection…'}
                            </span>
                          ) : null)}

                        {selectedMods.size > 0 && (
                          <div className="ms-auto flex w-full flex-wrap items-center gap-2 sm:w-auto bulk-bar-enter">
                            <span className="text-sm text-muted-foreground">
                              {String(selectedMods.size) + ' selected'}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={deselectAll}
                            >
                              {'Deselect'}
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => setConfirmBulkRemove(true)}
                              disabled={loading}
                            >
                              <Trash2 className="w-4 h-4 me-2" />
                              {'Remove'}
                            </Button>
                          </div>
                        )}

                        {selectedMods.size === 0 &&
                          visibleServerMods.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={selectAllVisible}
                              className="ms-auto w-full sm:w-auto"
                            >
                              {'Select All (' +
                                String(visibleServerMods.length) +
                                ')'}
                            </Button>
                          )}
                      </div>
                    )}

                    <Card>
                      <CardContent className="p-0">
                        {filteredMods.length === 0 ? (
                          searchQuery ? (
                            <div className="p-6">
                              <EmptyState
                                type="noResults"
                                title={'No mods match your search'}
                                description={
                                  'Try a different search term, or clear the filter.'
                                }
                                action={{
                                  label: 'Clear search',
                                  onClick: () => handleSearchChange(''),
                                  variant: 'outline',
                                }}
                              />
                            </div>
                          ) : (
                            <div className="px-4 py-10 sm:px-8">
                              <div className="mx-auto max-w-2xl">
                                <div className="flex flex-col items-center text-center mb-6">
                                  <div
                                    className="relative mb-4"
                                    aria-hidden="true"
                                  >
                                    <div className="absolute inset-0 rounded-2xl bg-primary/15 blur-xl" />
                                    <div className="relative w-16 h-16 rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center">
                                      <Package className="w-8 h-8 text-primary" />
                                    </div>
                                  </div>
                                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/80">
                                    {'No mods tracked yet'}
                                  </p>
                                  <h3 className="text-base font-semibold text-foreground">
                                    {'Add Workshop mods to start managing them'}
                                  </h3>
                                  <p className="mt-1.5 text-sm text-muted-foreground max-w-md leading-relaxed">
                                    {
                                      'The panel watches tracked mods for Workshop updates, surfaces conflicts, and lets you reorder load order with one click.'
                                    }
                                  </p>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">
                                  <button
                                    type="button"
                                    onClick={handleSyncFromServer}
                                    disabled={loading || !canManageMods}
                                    className="group text-start rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/[0.04] bg-muted/15 px-3 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                                  >
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <RefreshCw
                                        className="w-3.5 h-3.5 text-primary"
                                        aria-hidden="true"
                                      />
                                      <span className="text-xs font-semibold text-foreground/90">
                                        {'Sync from server'}
                                      </span>
                                      <ChevronRight
                                        className="w-3 h-3 ms-auto text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all"
                                        aria-hidden="true"
                                      />
                                    </div>
                                    <p className="text-[11px] text-muted-foreground leading-snug">
                                      {
                                        'Imports the WorkshopItems and Mods= lines from your active server config.'
                                      }
                                    </p>
                                    <p className="mt-1.5 text-[10px] uppercase tracking-wider text-primary/70">
                                      {'Recommended'}
                                    </p>
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() =>
                                      setCollectionDialogOpen(true)
                                    }
                                    disabled={loading}
                                    className="group text-start rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/[0.04] bg-muted/15 px-3 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                                  >
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <Library
                                        className="w-3.5 h-3.5 text-primary"
                                        aria-hidden="true"
                                      />
                                      <span className="text-xs font-semibold text-foreground/90">
                                        {'Import a Collection'}
                                      </span>
                                      <ChevronRight
                                        className="w-3 h-3 ms-auto text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all"
                                        aria-hidden="true"
                                      />
                                    </div>
                                    <p className="text-[11px] text-muted-foreground leading-snug">
                                      {
                                        'Paste a Steam Workshop collection URL to add every mod in it at once.'
                                      }
                                    </p>
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => setAdvancedAddOpen(true)}
                                    disabled={loading}
                                    className="group text-start rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/[0.04] bg-muted/15 px-3 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                                  >
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <PlusCircle
                                        className="w-3.5 h-3.5 text-primary"
                                        aria-hidden="true"
                                      />
                                      <span className="text-xs font-semibold text-foreground/90">
                                        {'Add a single mod'}
                                      </span>
                                      <ChevronRight
                                        className="w-3 h-3 ms-auto text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all"
                                        aria-hidden="true"
                                      />
                                    </div>
                                    <p className="text-[11px] text-muted-foreground leading-snug">
                                      {
                                        'Track a specific mod by its Workshop ID or full URL.'
                                      }
                                    </p>
                                  </button>
                                </div>

                                <p className="text-[11px] text-center text-muted-foreground/70 flex items-center justify-center gap-1.5">
                                  <Info
                                    className="w-3 h-3"
                                    aria-hidden="true"
                                  />
                                  {
                                    'Tracking is metadata only — mods are downloaded by your server, not the panel.'
                                  }
                                </p>
                              </div>
                            </div>
                          )
                        ) : (
                          <div
                            ref={modListRef}
                            className="h-[calc(100vh-340px)] min-h-[300px] overflow-y-auto"
                          >
                            <div
                              style={{
                                height: modListVirtualizer.getTotalSize(),
                                position: 'relative',
                              }}
                            >
                              {modListVirtualizer
                                .getVirtualItems()
                                .map((virtualRow) => {
                                  const item = flatModItems[virtualRow.index]
                                  const groupBorder =
                                    item.type === 'hint'
                                      ? 'border-s-2 border-muted-foreground/30'
                                      : item.group === 'update'
                                        ? 'border-s-2 border-warning'
                                        : item.group === 'neverChecked'
                                          ? 'border-s-2 border-muted-foreground/30'
                                          : 'border-s-2 border-primary/30'

                                  return (
                                    <div
                                      key={virtualRow.key}
                                      className={groupBorder}
                                      style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        transform: `translateY(${virtualRow.start}px)`,
                                      }}
                                    >
                                      {item.type === 'header' &&
                                        item.group === 'update' && (
                                          <div className="flex items-center gap-2.5 bg-warning/10 px-4 py-2.5 border-b border-warning/25">
                                            <span
                                              className="relative inline-flex shrink-0"
                                              aria-hidden="true"
                                            >
                                              <span className="absolute inset-0 rounded-full bg-warning/40 animate-ping" />
                                              <span className="relative w-2 h-2 rounded-full bg-warning" />
                                            </span>
                                            <span className="text-sm font-semibold text-warning">
                                              {'Updates Available'}
                                            </span>
                                            <span className="inline-flex h-5 items-center rounded-full bg-warning/20 px-2 font-mono text-[11px] tabular-nums text-warning">
                                              {item.count}
                                            </span>
                                          </div>
                                        )}
                                      {item.type === 'header' &&
                                        item.group === 'neverChecked' && (
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 bg-muted/20 px-4 py-2 border-b border-border/40 hover:bg-muted/30 transition-colors text-start"
                                            onClick={() =>
                                              setNeverCheckedExpanded(
                                                !neverCheckedExpanded,
                                              )
                                            }
                                            aria-expanded={neverCheckedExpanded}
                                          >
                                            <ChevronRight
                                              className={`w-4 h-4 text-muted-foreground transition-transform ${neverCheckedExpanded ? 'rotate-90' : ''}`}
                                            />
                                            <Clock className="w-4 h-4 text-muted-foreground" />
                                            <span className="text-sm font-medium text-muted-foreground">
                                              {'Never Checked'}
                                            </span>
                                            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
                                              {item.count}
                                            </span>
                                            {!neverCheckedExpanded && (
                                              <span className="ms-auto text-[11px] text-muted-foreground/70">
                                                {'Click to expand · or use'}{' '}
                                                <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-0 font-mono text-[10px]">
                                                  {'Check Updates'}
                                                </kbd>
                                              </span>
                                            )}
                                          </button>
                                        )}
                                      {item.type === 'header' &&
                                        item.group === 'upToDate' && (
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 bg-primary/5 px-4 py-2 border-b border-border/40 hover:bg-primary/10 transition-colors text-start"
                                            onClick={() =>
                                              setUpToDateExpanded(
                                                !upToDateExpanded,
                                              )
                                            }
                                            aria-expanded={upToDateExpanded}
                                          >
                                            <ChevronRight
                                              className={`w-4 h-4 text-primary transition-transform ${upToDateExpanded ? 'rotate-90' : ''}`}
                                            />
                                            <CheckCircle className="w-4 h-4 text-primary" />
                                            <span className="text-sm font-medium text-primary">
                                              {'Up to Date'}
                                            </span>
                                            <span className="font-mono text-[11px] tabular-nums text-primary/80">
                                              {item.count}
                                            </span>
                                          </button>
                                        )}
                                      {item.type === 'hint' && (
                                        <div className="flex items-center gap-3 bg-primary/5 border-b border-border/40 px-4 py-3">
                                          <RefreshCw className="w-4 h-4 text-primary shrink-0" />
                                          <p className="text-sm text-muted-foreground">
                                            <>
                                              {'Click '}
                                              {'Check Updates'}
                                              {
                                                ' above to scan all mods for new versions.'
                                              }
                                            </>
                                          </p>
                                        </div>
                                      )}
                                      {item.type === 'mod' && (
                                        <div className="border-b border-border/30">
                                          {renderModRow(item.mod)}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {showDisabled && (
                      <div className="rounded-lg border border-dashed border-border/50 bg-card/40">
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
                          <div className="flex items-center gap-2 text-sm">
                            <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />
                            <span className="font-medium text-muted-foreground">
                              {'Disabled mods on disk'}
                            </span>
                            {!disabledLoading && (
                              <span className="text-xs text-muted-foreground/70">
                                {'— downloaded but not loaded by the server'}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={fetchDisabled}
                              disabled={disabledLoading}
                            >
                              {disabledLoading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3.5 h-3.5" />
                              )}
                              <span className="ms-1.5">{'Refresh'}</span>
                            </Button>
                            {disabledMods.length > 0 && !disabledLoading && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={handleDeleteAllDisabled}
                                disabled={
                                  deletingId !== null ||
                                  loading ||
                                  !canManageMods
                                }
                              >
                                {deletingId === '__batch_disabled__' ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                                <span className="ms-1.5">{'Delete all'}</span>
                              </Button>
                            )}
                          </div>
                        </div>
                        {disabledLoading ? (
                          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                            <Loader2 className="w-4 h-4 animate-spin inline me-2" />
                            {'Scanning workshop folder…'}
                          </div>
                        ) : disabledMods.length === 0 ? (
                          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                            {
                              'No disabled mods. Everything in the workshop folder is enabled in the server INI.'
                            }
                          </div>
                        ) : (
                          <div className="divide-y divide-border/30">
                            {disabledMods.map((mod) => (
                              <div
                                key={mod.workshop_id}
                                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
                              >
                                <div className="flex items-center gap-2 min-w-0 opacity-70">
                                  <Package className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                                  <span className="truncate">{mod.name}</span>
                                  <span className="text-xs text-muted-foreground/60 tabular-nums shrink-0">
                                    {mod.workshop_id}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <a
                                        href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex"
                                      >
                                        <Button
                                          variant="ghost"
                                          size="iconDense"
                                          className="h-7 w-7 text-muted-foreground hover:text-primary"
                                        >
                                          <ExternalLink className="w-3.5 h-3.5" />
                                        </Button>
                                      </a>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {'Open Workshop page'}
                                    </TooltipContent>
                                  </Tooltip>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                    onClick={() =>
                                      handleEnableDiskMod(mod.workshop_id)
                                    }
                                    disabled={
                                      enablingId === mod.workshop_id ||
                                      deletingId !== null ||
                                      loading ||
                                      !canManageMods
                                    }
                                  >
                                    {enablingId === mod.workshop_id ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                      <>
                                        <Plus className="w-3.5 h-3.5 me-1" />
                                        {'Enable'}
                                      </>
                                    )}
                                  </Button>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="iconDense"
                                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                        onClick={() =>
                                          handleDeleteDiskMod(
                                            mod.workshop_id,
                                            mod.name,
                                          )
                                        }
                                        disabled={
                                          deletingId !== null ||
                                          enablingId === mod.workshop_id ||
                                          loading ||
                                          !canManageMods
                                        }
                                      >
                                        {deletingId === mod.workshop_id ? (
                                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                          <Trash2 className="w-3.5 h-3.5" />
                                        )}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {'Delete from disk'}
                                    </TooltipContent>
                                  </Tooltip>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {ignoredMods.length > 0 && (
                      <div className="rounded-lg border border-border/30 bg-card/50">
                        <button
                          type="button"
                          className="flex w-full items-center justify-between px-4 py-2.5 text-start text-sm text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => setIgnoredModsOpen(!ignoredModsOpen)}
                        >
                          <span className="flex items-center gap-2">
                            <EyeOff className="w-3.5 h-3.5" />
                            {Number(ignoredMods.length) === 1
                              ? String(ignoredMods.length) + ' ignored mod'
                              : String(ignoredMods.length) + ' ignored mods'}
                            <span className="text-xs opacity-60">
                              {"— won't be re-added by auto-sync"}
                            </span>
                          </span>
                          <ChevronRight
                            className={`w-4 h-4 transition-transform ${ignoredModsOpen ? 'rotate-90' : ''}`}
                          />
                        </button>
                        {ignoredModsOpen && (
                          <div className="border-t border-border/30 px-4 py-2 space-y-1">
                            {ignoredMods.map((mod) => (
                              <div
                                key={mod.workshop_id}
                                className="flex items-center justify-between gap-3 py-1.5 text-sm"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <EyeOff className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                                  <span className="truncate text-muted-foreground">
                                    {mod.name ||
                                      'Workshop Mod ' + String(mod.workshop_id)}
                                  </span>
                                  <span className="text-xs text-muted-foreground/50 tabular-nums shrink-0">
                                    {mod.workshop_id}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() =>
                                      handleUnignoreMod(mod.workshop_id)
                                    }
                                    disabled={
                                      loading ||
                                      deletingId !== null ||
                                      !canManageMods
                                    }
                                  >
                                    {'Re-track'}
                                  </Button>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="iconDense"
                                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                        onClick={() =>
                                          handleDeleteDiskMod(
                                            mod.workshop_id,
                                            mod.name || undefined,
                                          )
                                        }
                                        disabled={
                                          deletingId !== null ||
                                          loading ||
                                          !canManageMods
                                        }
                                      >
                                        {deletingId === mod.workshop_id ? (
                                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                          <Trash2 className="w-3.5 h-3.5" />
                                        )}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {'Delete from disk'}
                                    </TooltipContent>
                                  </Tooltip>
                                </div>
                              </div>
                            ))}
                            <div className="flex justify-end gap-1 pt-1 pb-0.5 border-t border-border/20 mt-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={handleDeleteAllIgnoredFromDisk}
                                disabled={
                                  loading ||
                                  deletingId !== null ||
                                  !canManageMods
                                }
                              >
                                {deletingId === '__batch_ignored__' ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                                <span className="ms-1.5">
                                  {'Delete all from disk'}
                                </span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                onClick={handleClearAllIgnored}
                                disabled={
                                  loading ||
                                  deletingId !== null ||
                                  !canManageMods
                                }
                              >
                                {'Clear all ignored'}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {CONFIG_VIEWS.includes(activeTab) && (
                  <div className="space-y-4">
                    {iniConfig?.configured ? (
                      <>
                        {configSubTab !== 'active' && (
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span className="tabular-nums">
                              {iniConfig.totalMods}{' '}
                              <span className="opacity-50">{'mods'}</span>
                            </span>
                            <span className="tabular-nums">
                              {iniConfig.workshopIds.length}{' '}
                              <span className="opacity-50">
                                {iniConfig.workshopIds.length !== 1
                                  ? 'workshop items'
                                  : 'workshop item'}
                              </span>
                            </span>
                            <span className="tabular-nums">
                              {iniConfig.maps.length}{' '}
                              <span className="opacity-50">
                                {iniConfig.maps.length !== 1 ? 'maps' : 'map'}
                              </span>
                            </span>
                          </div>
                        )}

                        {configSubTab === 'active' &&
                          (() => {
                            const {
                              orphaned,
                              enabledCount,
                              multiIdCount,
                              groups,
                              missingDepsMap,
                              duplicateModIds,
                            } = activeModsData
                            const { filteredGroups } = activeModsFiltered

                            const groupAttention = (g: WsGroup) => {
                              const enabledSet = new Set(
                                g.mods
                                  .filter((m) => m.enabled)
                                  .map((m) => m.id),
                              )
                              const siblings = siblingConflictsMap.get(g.wsId)
                              let clash = false
                              if (siblings) {
                                for (const [modId, sibs] of siblings) {
                                  if (!enabledSet.has(modId)) continue
                                  for (const s of sibs)
                                    if (enabledSet.has(s)) {
                                      clash = true
                                      break
                                    }
                                  if (clash) break
                                }
                              }
                              const missing = g.mods.some(
                                (m) =>
                                  m.enabled &&
                                  (missingDepsMap.get(m.id)?.length ?? 0) > 0,
                              )
                              const duplicate = g.mods.some((m) =>
                                duplicateModIds.has(m.id),
                              )
                              return {
                                clash,
                                missing,
                                duplicate,
                                any: clash || missing || duplicate,
                              }
                            }
                            const attentionCount = groups.filter(
                              (g) => groupAttention(g).any,
                            ).length

                            let displayGroups = filterMultiId
                              ? filteredGroups.filter((g) => g.mods.length > 1)
                              : filteredGroups
                            if (filterAttention)
                              displayGroups = displayGroups.filter(
                                (g) => groupAttention(g).any,
                              )
                            const totalModCount = groups.reduce(
                              (s, g) => s + g.mods.length,
                              0,
                            )
                            const q = deferredModManagerSearch
                              .toLowerCase()
                              .trim()
                            const inspectedGroup =
                              groups.find(
                                (g) => g.wsId === selectedActiveWsId,
                              ) ||
                              displayGroups[0] ||
                              null

                            const toggleMod = async (
                              mod: ModEntry,
                              wsId: string,
                            ) => {
                              if (busyRef.current || !canManageMods) return
                              const on = !mod.enabled
                              busyRef.current = true
                              try {
                                await modsApi.toggleModId(mod.id, on)
                                setIniConfig((prev) => {
                                  if (!prev) return prev
                                  const newModIds = on
                                    ? [...prev.modIds, mod.id]
                                    : prev.modIds.filter((id) => id !== mod.id)
                                  const newMap = { ...prev.workshopModMap }
                                  if (newMap[wsId]) {
                                    newMap[wsId] = newMap[wsId].map((m) =>
                                      m.id === mod.id
                                        ? { ...m, enabled: on }
                                        : m,
                                    )
                                  }
                                  return {
                                    ...prev,
                                    modIds: newModIds,
                                    totalMods: newModIds.length,
                                    workshopModMap: newMap,
                                  }
                                })
                                setOrderedModIds((prev) =>
                                  on
                                    ? [...prev, mod.id]
                                    : prev.filter((id) => id !== mod.id),
                                )
                                setLastSavedMod(mod.id)
                                if (savedTimeoutRef.current)
                                  clearTimeout(savedTimeoutRef.current)
                                savedTimeoutRef.current = setTimeout(
                                  () => setLastSavedMod(null),
                                  2000,
                                )
                              } catch (e) {
                                reportClientError('Failed to toggle mod', e)
                                toast({
                                  variant: 'destructive',
                                  title: 'Failed to toggle mod',
                                })
                              } finally {
                                busyRef.current = false
                              }
                            }

                            const dismissPair = async (
                              a: string,
                              b: string,
                            ) => {
                              if (!canManageMods) return
                              try {
                                await modsApi.addIgnoredModPair(a, b)
                                setIgnoredPairs((prev) => {
                                  const [x, y] = a < b ? [a, b] : [b, a]
                                  if (
                                    prev.some(
                                      (p) => p.mod_a === x && p.mod_b === y,
                                    )
                                  )
                                    return prev
                                  return [
                                    ...prev,
                                    {
                                      mod_a: x,
                                      mod_b: y,
                                      ignored_at: new Date().toISOString(),
                                    } as any,
                                  ]
                                })
                                toast({
                                  title: 'Conflict dismissed',
                                  description: `${a} ↔ ${b} marked as a false positive.`,
                                })
                              } catch (e) {
                                reportClientError(
                                  'Failed to dismiss conflict',
                                  e,
                                )
                                toast({
                                  variant: 'destructive',
                                  title: 'Failed to dismiss conflict',
                                })
                              }
                            }
                            const restorePair = async (
                              a: string,
                              b: string,
                            ) => {
                              if (!canManageMods) return
                              try {
                                await modsApi.removeIgnoredModPair(a, b)
                                setIgnoredPairs((prev) =>
                                  prev.filter((p) => {
                                    const [x, y] = a < b ? [a, b] : [b, a]
                                    return !(p.mod_a === x && p.mod_b === y)
                                  }),
                                )
                              } catch (e) {
                                reportClientError(
                                  'Failed to restore conflict',
                                  e,
                                )
                                toast({
                                  variant: 'destructive',
                                  title: 'Failed to restore conflict',
                                })
                              }
                            }

                            const toggleAllInGroup = async (g: WsGroup) => {
                              if (busyRef.current || !canManageMods) return
                              const on = !g.allEnabled
                              const modsToToggle = g.mods.filter(
                                (mod) => mod.enabled !== on,
                              )
                              if (modsToToggle.length === 0) return
                              busyRef.current = true
                              try {
                                await modsApi.batchToggleModIds(
                                  modsToToggle.map((mod) => ({
                                    modId: mod.id,
                                    enabled: on,
                                  })),
                                )
                                setIniConfig((prev) => {
                                  if (!prev) return prev
                                  let newModIds = [...prev.modIds]
                                  const newMap = { ...prev.workshopModMap }
                                  for (const mod of modsToToggle) {
                                    if (on) {
                                      if (!newModIds.includes(mod.id))
                                        newModIds.push(mod.id)
                                    } else {
                                      newModIds = newModIds.filter(
                                        (id) => id !== mod.id,
                                      )
                                    }
                                  }
                                  if (newMap[g.wsId]) {
                                    newMap[g.wsId] = newMap[g.wsId].map((m) => {
                                      const toggled = modsToToggle.find(
                                        (t) => t.id === m.id,
                                      )
                                      return toggled ? { ...m, enabled: on } : m
                                    })
                                  }
                                  return {
                                    ...prev,
                                    modIds: newModIds,
                                    totalMods: newModIds.length,
                                    workshopModMap: newMap,
                                  }
                                })
                                setOrderedModIds((prev) => {
                                  let next = [...prev]
                                  for (const mod of modsToToggle) {
                                    if (on) {
                                      if (!next.includes(mod.id))
                                        next.push(mod.id)
                                    } else {
                                      next = next.filter((id) => id !== mod.id)
                                    }
                                  }
                                  return next
                                })
                              } catch (e) {
                                reportClientError('Failed to toggle group', e)
                                toast({
                                  variant: 'destructive',
                                  title: 'Failed to toggle group',
                                })
                              } finally {
                                busyRef.current = false
                              }
                            }

                            const removeWorkshop = async (
                              wsId: string,
                              knownModIds?: string[],
                            ) => {
                              if (!canManageMods) return
                              try {
                                await modsApi.removeFromIni(
                                  wsId,
                                  undefined,
                                  knownModIds,
                                )
                                const updated = await modsApi.getCurrentConfig()
                                setIniConfig(updated)
                                if (updated?.modIds)
                                  setOrderedModIds(updated.modIds)
                                setLastSavedMod(`removed-${wsId}`)
                                if (savedTimeoutRef.current)
                                  clearTimeout(savedTimeoutRef.current)
                                savedTimeoutRef.current = setTimeout(
                                  () => setLastSavedMod(null),
                                  2000,
                                )
                              } catch (e) {
                                reportClientError(
                                  'Failed to remove workshop item',
                                  e,
                                )
                                toast({
                                  variant: 'destructive',
                                  title: 'Failed to remove workshop item',
                                })
                              }
                            }

                            const handleConfirmedRemoveWorkshop = async () => {
                              if (confirmRemoveWorkshop) {
                                await removeWorkshop(
                                  confirmRemoveWorkshop.wsId,
                                  confirmRemoveWorkshop.knownModIds,
                                )
                                setConfirmRemoveWorkshop(null)
                              }
                            }

                            const getGroupLabel = (g: WsGroup): string => {
                              const first = g.mods[0]
                              return first.name !== first.id
                                ? first.name
                                : first.id
                            }

                            const getGroupMissingDeps = (g: WsGroup) =>
                              Array.from(
                                new Set(
                                  g.mods.flatMap(
                                    (m) => missingDepsMap.get(m.id) || [],
                                  ),
                                ),
                              )
                            const getGroupDuplicateIds = (g: WsGroup) =>
                              g.mods
                                .filter((m) => duplicateModIds.has(m.id))
                                .map((m) => m.id)

                            const getInspectorDepKey = (
                              g: WsGroup,
                              dep: string,
                            ) => `active-${g.wsId}-${dep}`

                            const runInspectorDepSearch = async (
                              g: WsGroup,
                              dep: string,
                              force = false,
                            ) => {
                              if (!canManageMods) return
                              const key = getInspectorDepKey(g, dep)
                              if (
                                !force &&
                                depSearchData[key] &&
                                !depSearchData[key].error
                              )
                                return
                              setDepSearchData((prev) => ({
                                ...prev,
                                [key]: {
                                  loading: true,
                                  results: [],
                                  error: null,
                                  searchUrl: null,
                                },
                              }))
                              try {
                                const res = await modsApi.searchWorkshopMods(
                                  dep,
                                  {
                                    parentName: getGroupLabel(g),
                                    parentWorkshopId: g.wsId,
                                  },
                                )
                                setDepSearchData((prev) => ({
                                  ...prev,
                                  [key]: {
                                    loading: false,
                                    results: res.results || [],
                                    error: null,
                                    searchUrl: res.searchUrl,
                                    variantsTried: res.variantsTried,
                                    steamSearchEnabled: res.steamSearchEnabled,
                                  },
                                }))
                              } catch (err: any) {
                                setDepSearchData((prev) => ({
                                  ...prev,
                                  [key]: {
                                    loading: false,
                                    results: [],
                                    error: getUserErrorMessage(
                                      err,
                                      'Search failed',
                                    ),
                                    searchUrl: null,
                                  },
                                }))
                              }
                            }

                            const toggleInspectorDepSearch = (
                              g: WsGroup,
                              dep: string,
                            ) => {
                              const key = getInspectorDepKey(g, dep)
                              setDepSearchOpen((prev) => {
                                const next = new Set(prev)
                                if (next.has(key)) next.delete(key)
                                else next.add(key)
                                return next
                              })
                              if (!depSearchData[key])
                                runInspectorDepSearch(g, dep)
                            }

                            const handleInspectorAddDep = async (
                              hit: DepSearchHit,
                              dep: string,
                              key: string,
                            ) => {
                              if (busyRef.current || !canManageMods) return
                              busyRef.current = true
                              setDepAdding((prev) => [...prev, key])
                              try {
                                await modsApi.addMissingDep(
                                  hit.workshopId,
                                  hit.modId || dep,
                                )
                                setDepAddResults((prev) => ({
                                  ...prev,
                                  [key]: 'added' as const,
                                }))
                                const updated = await modsApi.getCurrentConfig()
                                setIniConfig(updated)
                                if (updated?.modIds)
                                  setOrderedModIds(updated.modIds)
                                toast({
                                  title: 'Dependency added',
                                  description:
                                    String(hit.modName) +
                                    ' added to the server config.',
                                })
                              } catch (err) {
                                reportClientError(
                                  'Failed to add dependency from inspector.',
                                  err,
                                )
                                setDepAddResults((prev) => ({
                                  ...prev,
                                  [key]: 'error' as const,
                                }))
                                toast({
                                  title: 'Add failed',
                                  description: getUserErrorMessage(
                                    err,
                                    'Could not add dependency.',
                                  ),
                                  variant: 'destructive',
                                })
                              } finally {
                                setDepAdding((prev) =>
                                  prev.filter((item) => item !== key),
                                )
                                busyRef.current = false
                              }
                            }

                            return (
                              <div className="space-y-3 sub-tab-enter">
                                {detectedConflicts.length > 0 && (
                                  <div className="space-y-1.5">
                                    {detectedConflicts.map((conflict, idx) => (
                                      <div
                                        key={idx}
                                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${
                                          conflict.severity === 'warning'
                                            ? 'bg-warning/10 border-warning/40'
                                            : 'bg-primary/10 border-primary/30'
                                        }`}
                                      >
                                        <AlertTriangle
                                          className={`w-3.5 h-3.5 shrink-0 ${conflict.severity === 'warning' ? 'text-warning' : 'text-primary'}`}
                                        />
                                        <span className="flex-1 min-w-0 break-words">
                                          <span
                                            className={`font-medium ${conflict.severity === 'warning' ? 'text-warning' : 'text-primary'}`}
                                          >
                                            {conflict.type === 'duplicate' &&
                                              'Duplicate Mods'}
                                            {conflict.type ===
                                              'missing_modid' &&
                                              'Missing Mod IDs'}
                                            {conflict.type ===
                                              'outdated_dependency' &&
                                              'Outdated Dependency'}
                                          </span>
                                          <span className="text-muted-foreground">
                                            : {conflict.message}
                                          </span>
                                        </span>
                                        {conflict.type === 'duplicate' && (
                                          <DisabledReason
                                            reason={
                                              !canManageMods
                                                ? 'Your role does not have permission to manage mods.'
                                                : null
                                            }
                                          >
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              className="shrink-0 h-8 text-xs border-warning/40 text-warning hover:bg-warning/20"
                                              disabled={
                                                deduplicating || !canManageMods
                                              }
                                              onClick={async () => {
                                                if (!canManageMods) return
                                                setDeduplicating(true)
                                                setDeduplicateResult(null)
                                                try {
                                                  const result =
                                                    await modsApi.deduplicateModIds()
                                                  setDeduplicateResult(
                                                    result.message,
                                                  )
                                                  if (
                                                    result.removed.length > 0
                                                  ) {
                                                    const updated =
                                                      await modsApi.getCurrentConfig()
                                                    setIniConfig(updated)
                                                    if (updated?.modIds)
                                                      setOrderedModIds(
                                                        updated.modIds,
                                                      )
                                                  }
                                                } catch (err: unknown) {
                                                  const errMsg =
                                                    getUserErrorMessage(
                                                      err,
                                                      'Failed to deduplicate',
                                                    )
                                                  const msg = errMsg.includes(
                                                    '<',
                                                  )
                                                    ? 'Failed to deduplicate — server endpoint not available'
                                                    : errMsg
                                                  setDeduplicateResult(
                                                    'Error: ' + String(msg),
                                                  )
                                                } finally {
                                                  setDeduplicating(false)
                                                }
                                              }}
                                            >
                                              {deduplicating ? (
                                                <Loader2 className="w-3 h-3 animate-spin me-1" />
                                              ) : (
                                                <Wrench className="w-3 h-3 me-1" />
                                              )}
                                              {'Fix'}
                                            </Button>
                                          </DisabledReason>
                                        )}
                                      </div>
                                    ))}
                                    {deduplicateResult && (
                                      <p
                                        className={`text-xs px-3 ${deduplicateResult.startsWith('Removed') ? 'text-success' : 'text-muted-foreground'}`}
                                      >
                                        {deduplicateResult}
                                      </p>
                                    )}
                                  </div>
                                )}

                                <div className="rounded-lg border border-border/45 bg-card/35 px-3 py-2.5">
                                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                    <div className="min-w-0 space-y-2">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span
                                          className="inline-flex items-center gap-1.5 rounded border border-primary/35 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                                          title={
                                            String(enabledCount) +
                                            ' of ' +
                                            String(totalModCount) +
                                            ' mod IDs are currently enabled. "Mod IDs" are the internal names PZ loads — a single Workshop item can ship several IDs (variants, add-on packs, etc.).'
                                          }
                                        >
                                          <span className="font-mono tabular-nums text-foreground">
                                            {enabledCount}
                                          </span>
                                          <span className="text-muted-foreground">
                                            {'of'}
                                          </span>
                                          <span className="font-mono tabular-nums text-foreground">
                                            {totalModCount}
                                          </span>
                                          <span>{'IDs enabled'}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded border border-border/45 bg-muted/25 px-2 py-1 text-[11px] text-muted-foreground">
                                          <Package
                                            className="h-3 w-3"
                                            aria-hidden="true"
                                          />
                                          <span className="font-mono tabular-nums text-foreground/85">
                                            {groups.length}
                                          </span>
                                          {groups.length !== 1
                                            ? 'Workshop items'
                                            : 'Workshop item'}
                                        </span>
                                        {attentionCount > 0 && (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setFilterAttention(
                                                !filterAttention,
                                              )
                                            }
                                            aria-pressed={filterAttention}
                                            title={
                                              'Show only workshop items with a confirmed variant clash, a missing required mod ID, or a duplicate internal ID.'
                                            }
                                            className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50 ${filterAttention ? 'border-destructive/60 bg-destructive/20 text-destructive' : 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15'}`}
                                          >
                                            <AlertTriangle
                                              className="h-3 w-3 shrink-0"
                                              aria-hidden="true"
                                            />
                                            {'Needs attention (' +
                                              String(attentionCount) +
                                              ')'}
                                          </button>
                                        )}
                                        {multiIdCount > 0 && (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setFilterMultiId(!filterMultiId)
                                            }
                                            aria-pressed={filterMultiId}
                                            title={
                                              filterMultiId
                                                ? 'Showing only workshop items with more than one mod ID. These are usually variants where only some should be enabled together.'
                                                : 'Show only workshop items with multiple mod IDs (usually variants — only enable the ones you want).'
                                            }
                                            className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${filterMultiId ? 'bg-primary/20 border-primary/50 text-primary' : 'border-border/40 text-muted-foreground hover:bg-muted/35 hover:text-foreground'}`}
                                          >
                                            <Filter
                                              className="h-3 w-3"
                                              aria-hidden="true"
                                            />
                                            {'Multi-ID (' +
                                              String(multiIdCount) +
                                              ')'}
                                          </button>
                                        )}
                                        {missingDepsMap.size > 0 && (
                                          <span
                                            className="inline-flex items-center gap-1.5 rounded border border-destructive/45 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive"
                                            title={
                                              "At least one enabled mod requires another mod that isn't enabled. See the Conflicts tab → Missing Dependencies."
                                            }
                                          >
                                            <AlertTriangle
                                              className="w-3 h-3 shrink-0"
                                              aria-hidden="true"
                                            />
                                            {missingDepsMap.size !== 1
                                              ? String(missingDepsMap.size) +
                                                ' missing deps'
                                              : String(missingDepsMap.size) +
                                                ' missing dep'}
                                          </span>
                                        )}
                                        {duplicateModIds.size > 0 && (
                                          <span
                                            className="inline-flex items-center gap-1.5 rounded border border-warning/45 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning"
                                            title={
                                              'Multiple workshop items declare the same internal mod ID. Only one will load — review the Conflicts tab.'
                                            }
                                          >
                                            <AlertTriangle
                                              className="w-3 h-3 shrink-0"
                                              aria-hidden="true"
                                            />
                                            {duplicateModIds.size !== 1
                                              ? String(duplicateModIds.size) +
                                                ' duplicate IDs'
                                              : String(duplicateModIds.size) +
                                                ' duplicate ID'}
                                          </span>
                                        )}
                                        {lastSavedMod && (
                                          <span className="text-[11px] text-success flex items-center gap-1 animate-in fade-in duration-300">
                                            <Check className="w-3 h-3" />{' '}
                                            {'Saved to INI'}
                                          </span>
                                        )}
                                      </div>
                                      <details className="group/help">
                                        <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground">
                                          <ChevronRight
                                            className="h-3 w-3 transition-transform group-open/help:rotate-90"
                                            aria-hidden="true"
                                          />
                                          {'What am I looking at?'}
                                        </summary>
                                        <p className="mt-1.5 max-w-prose text-[11px] leading-4 text-muted-foreground/75">
                                          {
                                            'This is what the server config actually loads. A Workshop item can ship several internal mod IDs — add-ons, variants, and shared libraries. Enabled IDs are green; those are the ones Project Zomboid loads. Select a row to toggle its IDs in the panel on the right.'
                                          }
                                        </p>
                                      </details>
                                    </div>
                                    <div className="flex w-full shrink-0 flex-col gap-2 lg:w-auto lg:items-end">
                                      <div className="relative w-full lg:w-72">
                                        <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                                        <Input
                                          value={modManagerSearch}
                                          onChange={(e) =>
                                            handleModManagerSearchChange(
                                              e.target.value,
                                            )
                                          }
                                          placeholder={'Filter active mods...'}
                                          aria-label={'Filter active mods'}
                                          className="h-9 text-xs ps-8 bg-background/60"
                                        />
                                        {modManagerSearch && (
                                          <button
                                            onClick={() => {
                                              handleModManagerSearchChange('')
                                            }}
                                            aria-label={'Clear search'}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded"
                                          >
                                            ✕
                                          </button>
                                        )}
                                      </div>
                                      <div
                                        className="inline-flex items-center gap-1 rounded-md border border-border/45 bg-muted/20 p-0.5"
                                        role="group"
                                        aria-label={'List density'}
                                      >
                                        {(['compact', 'detailed'] as const).map(
                                          (d) => (
                                            <button
                                              key={d}
                                              type="button"
                                              onClick={() =>
                                                setActiveDensity(d)
                                              }
                                              aria-pressed={activeDensity === d}
                                              title={
                                                d === 'compact'
                                                  ? 'One line per Workshop item. Toggle individual mod IDs in the panel on the right.'
                                                  : 'Show every mod ID as a clickable chip inside each row.'
                                              }
                                              className={`rounded px-2 py-1 text-[11px] font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${activeDensity === d ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                                            >
                                              {d === 'compact'
                                                ? 'compact'
                                                : 'detailed'}
                                            </button>
                                          ),
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_21rem]">
                                  <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/50 shadow-md">
                                    {displayGroups.length > 0 ? (
                                      <ScrollArea className="h-[calc(100vh-340px)] min-h-[300px]">
                                        <div className="min-w-0 divide-y divide-border/60 [&>*:nth-child(even)]:bg-card/70">
                                          {displayGroups.map((g) => {
                                            const isSingle = g.mods.length === 1
                                            const mod0 = g.mods[0]
                                            const isInspected =
                                              inspectedGroup?.wsId === g.wsId
                                            const label = getGroupLabel(g)
                                            const att = groupAttention(g)
                                            const enabledN = g.mods.filter(
                                              (m) => m.enabled,
                                            ).length
                                            const totalN = g.mods.length
                                            const showChips =
                                              !isSingle &&
                                              (activeDensity === 'detailed' ||
                                                isInspected)
                                            const groupMissing = g.mods.flatMap(
                                              (m) =>
                                                missingDepsMap.get(m.id) || [],
                                            )
                                            const groupRequires = g.mods
                                              .flatMap((m) => m.require || [])
                                              .filter(
                                                (v, i, a) => a.indexOf(v) === i,
                                              )
                                            const missingRequired =
                                              groupRequires.filter((dep) =>
                                                groupMissing.includes(dep),
                                              )

                                            const countTone = att.any
                                              ? 'border-destructive/40 bg-destructive/10 text-destructive'
                                              : g.allEnabled
                                                ? 'border-success/30 bg-success/10 text-success'
                                                : g.someEnabled
                                                  ? 'border-border/45 bg-muted/25 text-foreground/80'
                                                  : 'border-border/45 bg-muted/25 text-muted-foreground'

                                            const kebab = (
                                              <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                  <Button
                                                    variant="ghost"
                                                    size="iconDense"
                                                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                                                    aria-label={
                                                      'More actions for ' +
                                                      String(label)
                                                    }
                                                  >
                                                    <MoreVertical className="h-4 w-4" />
                                                  </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                  <DropdownMenuItem
                                                    onClick={() =>
                                                      copyText(g.wsId)
                                                        .then(() =>
                                                          toast({
                                                            title: 'Copied',
                                                            description:
                                                              'Workshop ID ' +
                                                              String(g.wsId),
                                                          }),
                                                        )
                                                        .catch(() => {})
                                                    }
                                                  >
                                                    <FileText className="me-2 h-4 w-4" />
                                                    {'Copy Workshop ID'}
                                                  </DropdownMenuItem>
                                                  <DropdownMenuSeparator />
                                                  <DisabledReason
                                                    reason={
                                                      !canManageMods
                                                        ? 'Your role does not have permission to manage mods.'
                                                        : null
                                                    }
                                                    className="w-full"
                                                  >
                                                    <DropdownMenuItem
                                                      className="text-destructive focus:text-destructive"
                                                      // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27 (rule's own shape-2 guidance): the disabled-reason branch (mods.manage) now lives in the DisabledReason wrapper above; this title carries only the always-relevant "what removing does" hint, correctly absent (via DisabledReason's own tooltip taking over) rather than dead when actually disabled.
                                                      title={
                                                        "Stops this mod loading by removing its workshop and mod IDs from the server INI. Keeps it in the panel's tracked list."
                                                      }
                                                      onClick={() => {
                                                        if (!canManageMods)
                                                          return
                                                        setConfirmRemoveWorkshop(
                                                          {
                                                            wsId: g.wsId,
                                                            knownModIds:
                                                              g.mods.map(
                                                                (m) => m.id,
                                                              ),
                                                          },
                                                        )
                                                      }}
                                                      disabled={!canManageMods}
                                                    >
                                                      <Trash2 className="me-2 h-4 w-4" />
                                                      {'Remove from server INI'}
                                                    </DropdownMenuItem>
                                                  </DisabledReason>
                                                  <DropdownMenuSeparator />
                                                  <DisabledReason
                                                    reason={
                                                      !canManageMods
                                                        ? 'Your role does not have permission to manage mods.'
                                                        : null
                                                    }
                                                    className="w-full"
                                                  >
                                                    <DropdownMenuItem
                                                      className="text-destructive focus:text-destructive"
                                                      // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27 (rule's own shape-2 guidance): the disabled-reason branch (mods.manage) now lives in the DisabledReason wrapper above; this title carries only the always-relevant "what removing does" hint, correctly absent (via DisabledReason's own tooltip taking over) rather than dead when actually disabled.
                                                      title={
                                                        "Stops this mod loading and removes it from the panel's tracked list. Workshop files remain on disk."
                                                      }
                                                      onClick={() => {
                                                        if (!canManageMods)
                                                          return
                                                        setConfirmRemoveMod(
                                                          g.wsId,
                                                        )
                                                      }}
                                                      disabled={!canManageMods}
                                                    >
                                                      <Trash2 className="me-2 h-4 w-4" />
                                                      {'Remove from server'}
                                                    </DropdownMenuItem>
                                                  </DisabledReason>
                                                </DropdownMenuContent>
                                              </DropdownMenu>
                                            )

                                            const missingRequiredBlock =
                                              missingRequired.length > 0 ? (
                                                <div className="flex flex-wrap items-center gap-1 rounded border border-destructive/35 bg-destructive/10 px-2 py-1">
                                                  <AlertTriangle
                                                    className="h-3 w-3 text-destructive"
                                                    aria-hidden="true"
                                                  />
                                                  <span className="text-[10px] font-medium text-destructive/90">
                                                    {'Missing required ID:'}
                                                  </span>
                                                  {missingRequired.map(
                                                    (dep) => (
                                                      <span
                                                        key={dep}
                                                        className="rounded border border-destructive/30 bg-destructive/15 px-1 font-mono text-[10px] text-destructive"
                                                        title={
                                                          String(dep) +
                                                          ' is not enabled — this mod may not work'
                                                        }
                                                      >
                                                        {dep}
                                                      </span>
                                                    ),
                                                  )}
                                                </div>
                                              ) : null

                                            if (isSingle) {
                                              return (
                                                <ModRow
                                                  key={g.wsId}
                                                  selected={isInspected}
                                                  dimmed={!mod0.enabled}
                                                  onClick={() =>
                                                    setSelectedActiveWsId(
                                                      g.wsId,
                                                    )
                                                  }
                                                  leading={
                                                    <Checkbox
                                                      checked={mod0.enabled}
                                                      onCheckedChange={() =>
                                                        toggleMod(mod0, g.wsId)
                                                      }
                                                      aria-label={
                                                        String(
                                                          mod0.enabled
                                                            ? 'Disable'
                                                            : 'Enable',
                                                        ) +
                                                        ' ' +
                                                        String(
                                                          mod0.name || mod0.id,
                                                        )
                                                      }
                                                    />
                                                  }
                                                  title={
                                                    <span className="truncate text-sm font-semibold leading-tight text-foreground">
                                                      {mod0.name || mod0.id}
                                                    </span>
                                                  }
                                                  titleBadges={
                                                    <>
                                                      {mod0.name !==
                                                        mod0.id && (
                                                        <span className="inline-flex items-center rounded border border-success/25 bg-success/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-success">
                                                          {mod0.id}
                                                        </span>
                                                      )}
                                                      {att.duplicate && (
                                                        <span
                                                          className="shrink-0 rounded border border-warning/30 bg-warning/15 px-1.5 text-[10px] text-warning"
                                                          title={
                                                            Number(
                                                              (
                                                                duplicateModIds.get(
                                                                  mod0.id,
                                                                ) || []
                                                              ).filter(
                                                                (w) =>
                                                                  w !== g.wsId,
                                                              ).length,
                                                            ) === 1
                                                              ? 'Also provided by workshop item ' +
                                                                String(
                                                                  (
                                                                    duplicateModIds.get(
                                                                      mod0.id,
                                                                    ) || []
                                                                  )
                                                                    .filter(
                                                                      (w) =>
                                                                        w !==
                                                                        g.wsId,
                                                                    )
                                                                    .join(', '),
                                                                )
                                                              : 'Also provided by workshop items ' +
                                                                String(
                                                                  (
                                                                    duplicateModIds.get(
                                                                      mod0.id,
                                                                    ) || []
                                                                  )
                                                                    .filter(
                                                                      (w) =>
                                                                        w !==
                                                                        g.wsId,
                                                                    )
                                                                    .join(', '),
                                                                )
                                                          }
                                                        >
                                                          {'duplicate'}
                                                        </span>
                                                      )}
                                                    </>
                                                  }
                                                  meta={
                                                    <>
                                                      <span
                                                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${mod0.enabled ? 'border-success/30 bg-success/10 text-success' : 'border-border/45 bg-muted/25 text-muted-foreground'}`}
                                                      >
                                                        <span
                                                          className={`h-1.5 w-1.5 rounded-full ${mod0.enabled ? 'bg-success' : 'bg-muted-foreground/50'}`}
                                                          aria-hidden="true"
                                                        />
                                                        {mod0.enabled
                                                          ? 'Enabled'
                                                          : 'Disabled'}
                                                      </span>
                                                      <WorkshopIdChip
                                                        wsId={g.wsId}
                                                        onCopied={(id) =>
                                                          toast({
                                                            title: 'Copied',
                                                            description:
                                                              'Workshop ID ' +
                                                              String(id),
                                                          })
                                                        }
                                                      />
                                                    </>
                                                  }
                                                  actions={
                                                    <>
                                                      <WorkshopLinkAction
                                                        wsId={g.wsId}
                                                        label={
                                                          mod0.name || mod0.id
                                                        }
                                                      />
                                                      {kebab}
                                                    </>
                                                  }
                                                  footer={
                                                    mod0.enabled
                                                      ? missingRequiredBlock
                                                      : null
                                                  }
                                                />
                                              )
                                            }

                                            return (
                                              <ModRow
                                                key={g.wsId}
                                                selected={isInspected}
                                                dimmed={!g.someEnabled}
                                                onClick={() =>
                                                  setSelectedActiveWsId(g.wsId)
                                                }
                                                leading={
                                                  <div
                                                    className={`h-2 w-2 rounded-sm ${g.allEnabled ? 'bg-success' : g.someEnabled ? 'bg-success/40' : 'bg-muted-foreground/20'}`}
                                                    aria-hidden="true"
                                                  />
                                                }
                                                title={
                                                  <span className="truncate text-sm font-semibold leading-tight text-foreground">
                                                    {label}
                                                  </span>
                                                }
                                                titleBadges={
                                                  <span
                                                    className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium tabular-nums ${countTone}`}
                                                    title={
                                                      String(enabledN) +
                                                      ' of ' +
                                                      String(totalN) +
                                                      ' mod IDs enabled. Some workshop items ship multiple compatible IDs (e.g. add-on packs); others ship alternatives (e.g. Lite vs Full). Check the workshop page if unsure.'
                                                    }
                                                  >
                                                    <span>{enabledN}</span>
                                                    <span className="opacity-60">
                                                      {'of'}
                                                    </span>
                                                    <span>{totalN}</span>
                                                    <span className="hidden opacity-75 sm:inline">
                                                      {'enabled'}
                                                    </span>
                                                  </span>
                                                }
                                                meta={
                                                  <WorkshopIdChip
                                                    wsId={g.wsId}
                                                    onCopied={(id) =>
                                                      toast({
                                                        title: 'Copied',
                                                        description:
                                                          'Workshop ID ' +
                                                          String(id),
                                                      })
                                                    }
                                                  />
                                                }
                                                actions={
                                                  <>
                                                    <WorkshopLinkAction
                                                      wsId={g.wsId}
                                                      label={label}
                                                      hint={
                                                        'Open the workshop page to see which mod ID(s) you should enable'
                                                      }
                                                    />
                                                    {kebab}
                                                  </>
                                                }
                                                footer={
                                                  <>
                                                    {showChips && (
                                                      <div className="flex flex-wrap gap-1">
                                                        {(() => {
                                                          const groupSiblings =
                                                            siblingConflictsMap.get(
                                                              g.wsId,
                                                            )
                                                          const enabledSet =
                                                            new Set(
                                                              g.mods
                                                                .filter(
                                                                  (m) =>
                                                                    m.enabled,
                                                                )
                                                                .map(
                                                                  (m) => m.id,
                                                                ),
                                                            )
                                                          const scanClashing =
                                                            new Set<string>()
                                                          if (groupSiblings) {
                                                            for (const [
                                                              modId,
                                                              sibs,
                                                            ] of groupSiblings) {
                                                              if (
                                                                !enabledSet.has(
                                                                  modId,
                                                                )
                                                              )
                                                                continue
                                                              for (const s of sibs) {
                                                                if (
                                                                  enabledSet.has(
                                                                    s,
                                                                  )
                                                                ) {
                                                                  scanClashing.add(
                                                                    modId,
                                                                  )
                                                                  scanClashing.add(
                                                                    s,
                                                                  )
                                                                }
                                                              }
                                                            }
                                                          }
                                                          return g.mods.map(
                                                            (mod) => {
                                                              const isDupe =
                                                                duplicateModIds.has(
                                                                  mod.id,
                                                                )
                                                              const sibConflicts =
                                                                groupSiblings?.get(
                                                                  mod.id,
                                                                )
                                                              const hasScanOverlap =
                                                                !!sibConflicts &&
                                                                sibConflicts.size >
                                                                  0
                                                              const isScanClashing =
                                                                scanClashing.has(
                                                                  mod.id,
                                                                )
                                                              const sibList =
                                                                sibConflicts
                                                                  ? Array.from(
                                                                      sibConflicts,
                                                                    )
                                                                  : []
                                                              const enabledSibs =
                                                                sibList.filter(
                                                                  (s) =>
                                                                    enabledSet.has(
                                                                      s,
                                                                    ),
                                                                )
                                                              const fmtSibs = (
                                                                arr: string[],
                                                              ) =>
                                                                arr.length <= 4
                                                                  ? arr.join(
                                                                      ', ',
                                                                    )
                                                                  : `${arr.slice(0, 4).join(', ')} (+${arr.length - 4} more)`
                                                              const tooltipBits =
                                                                [
                                                                  `${mod.id}${mod.name !== mod.id ? ` — ${mod.name}` : ''}`,
                                                                  isDupe
                                                                    ? '⚠ Also in workshop ' +
                                                                      String(
                                                                        (
                                                                          duplicateModIds.get(
                                                                            mod.id,
                                                                          ) ||
                                                                          []
                                                                        )
                                                                          .filter(
                                                                            (
                                                                              w,
                                                                            ) =>
                                                                              w !==
                                                                              g.wsId,
                                                                          )
                                                                          .join(
                                                                            ', ',
                                                                          ),
                                                                      )
                                                                    : null,
                                                                  isScanClashing
                                                                    ? '⚠ Conflicts with ' +
                                                                      String(
                                                                        fmtSibs(
                                                                          enabledSibs,
                                                                        ),
                                                                      ) +
                                                                      ' — both are enabled and share files. The one loaded last will overwrite the other.'
                                                                    : hasScanOverlap
                                                                      ? 'Variant of ' +
                                                                        String(
                                                                          fmtSibs(
                                                                            sibList,
                                                                          ),
                                                                        ) +
                                                                        ' — these share files, so only one should be enabled at a time. Currently safe.'
                                                                      : null,
                                                                  mod.enabled
                                                                    ? 'Click to disable'
                                                                    : 'Click to enable',
                                                                ]
                                                                  .filter(
                                                                    Boolean,
                                                                  )
                                                                  .join('\n')
                                                              const styleClass =
                                                                isScanClashing
                                                                  ? mod.enabled
                                                                    ? 'bg-destructive/20 text-destructive hover:bg-destructive/30 ring-1 ring-destructive/50'
                                                                    : 'bg-destructive/5 text-destructive/60 hover:bg-destructive/10 ring-1 ring-destructive/20'
                                                                  : hasScanOverlap
                                                                    ? mod.enabled
                                                                      ? 'bg-success/15 text-success hover:bg-success/25 ring-1 ring-warning/30'
                                                                      : 'bg-muted/15 text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/25 ring-1 ring-warning/20'
                                                                    : isDupe
                                                                      ? mod.enabled
                                                                        ? 'bg-warning/15 text-warning hover:bg-warning/25 ring-1 ring-warning/30'
                                                                        : 'bg-warning/5 text-warning/50 hover:bg-warning/10 ring-1 ring-warning/20'
                                                                      : mod.enabled
                                                                        ? 'bg-success/15 text-success hover:bg-success/25'
                                                                        : 'bg-muted/15 text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/25'
                                                              return (
                                                                <DisabledReason
                                                                  key={mod.id}
                                                                  reason={
                                                                    !canManageMods
                                                                      ? 'Your role does not have permission to manage mods.'
                                                                      : null
                                                                  }
                                                                >
                                                                  <button
                                                                    onClick={(
                                                                      e,
                                                                    ) => {
                                                                      e.stopPropagation()
                                                                      toggleMod(
                                                                        mod,
                                                                        g.wsId,
                                                                      )
                                                                    }}
                                                                    disabled={
                                                                      !canManageMods
                                                                    }
                                                                    // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27 (rule's own shape-2 guidance): the disabled-reason branch (mods.manage) now lives in the DisabledReason wrapper above; this title carries only the always-relevant chip tooltip (id/name, dupe/clash/overlap warnings, click hint), correctly absent rather than dead when actually disabled.
                                                                    title={
                                                                      tooltipBits
                                                                    }
                                                                    className={`mod-toggle-pill inline-flex max-w-[200px] items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${canManageMods ? 'cursor-pointer' : ''} ${styleClass}`}
                                                                  >
                                                                    {isScanClashing && (
                                                                      <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-destructive" />
                                                                    )}
                                                                    {!isScanClashing &&
                                                                      hasScanOverlap && (
                                                                        <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-warning/70" />
                                                                      )}
                                                                    <span className="truncate">
                                                                      {mod.id}
                                                                    </span>
                                                                  </button>
                                                                </DisabledReason>
                                                              )
                                                            },
                                                          )
                                                        })()}
                                                      </div>
                                                    )}
                                                    {(() => {
                                                      const enabledMods =
                                                        g.mods.filter(
                                                          (m) => m.enabled,
                                                        )
                                                      const enabledIds =
                                                        enabledMods.map(
                                                          (m) => m.id,
                                                        )
                                                      const enabledSet =
                                                        new Set(enabledIds)
                                                      const hasMultipleEnabled =
                                                        g.mods.length > 1 &&
                                                        enabledIds.length >= 2
                                                      const groupSiblings =
                                                        siblingConflictsMap.get(
                                                          g.wsId,
                                                        )
                                                      const scanClashingPairs: [
                                                        string,
                                                        string,
                                                      ][] = []
                                                      if (groupSiblings) {
                                                        const seen =
                                                          new Set<string>()
                                                        for (const [
                                                          modId,
                                                          sibs,
                                                        ] of groupSiblings) {
                                                          if (
                                                            !enabledSet.has(
                                                              modId,
                                                            )
                                                          )
                                                            continue
                                                          for (const s of sibs) {
                                                            if (
                                                              !enabledSet.has(s)
                                                            )
                                                              continue
                                                            const key = [
                                                              modId,
                                                              s,
                                                            ]
                                                              .sort()
                                                              .join('--')
                                                            if (seen.has(key))
                                                              continue
                                                            seen.add(key)
                                                            scanClashingPairs.push(
                                                              [modId, s],
                                                            )
                                                          }
                                                        }
                                                      }
                                                      const groupModIds =
                                                        new Set(
                                                          g.mods.map(
                                                            (m) => m.id,
                                                          ),
                                                        )
                                                      const dismissedHere =
                                                        ignoredPairs.filter(
                                                          (p) =>
                                                            groupModIds.has(
                                                              p.mod_a,
                                                            ) &&
                                                            groupModIds.has(
                                                              p.mod_b,
                                                            ),
                                                        )

                                                      if (
                                                        scanClashingPairs.length >
                                                        0
                                                      ) {
                                                        return (
                                                          <div
                                                            role="alert"
                                                            className="flex flex-wrap items-start gap-1.5 text-[11px] sm:items-center"
                                                          >
                                                            <AlertTriangle
                                                              aria-hidden="true"
                                                              className="mt-px h-3.5 w-3.5 shrink-0 text-destructive sm:mt-0"
                                                            />
                                                            <span className="min-w-0 break-words font-medium text-destructive/90">
                                                              {
                                                                'Two variants of this mod are enabled and share files. One will overwrite the other — disable one.'
                                                              }
                                                            </span>
                                                            <DisabledReason
                                                              reason={
                                                                !canManageMods
                                                                  ? 'Your role does not have permission to manage mods.'
                                                                  : null
                                                              }
                                                            >
                                                              <button
                                                                type="button"
                                                                onClick={(
                                                                  e,
                                                                ) => {
                                                                  e.stopPropagation()
                                                                  for (const [
                                                                    a,
                                                                    b,
                                                                  ] of scanClashingPairs)
                                                                    dismissPair(
                                                                      a,
                                                                      b,
                                                                    )
                                                                }}
                                                                disabled={
                                                                  !canManageMods
                                                                }
                                                                // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27 (rule's own shape-2 guidance): the disabled-reason branch (mods.manage) now lives in the DisabledReason wrapper above; this title carries only the always-relevant dismiss-pair hint, correctly absent rather than dead when actually disabled.
                                                                title={
                                                                  scanClashingPairs.length ===
                                                                  1
                                                                    ? 'Mark "' +
                                                                      String(
                                                                        scanClashingPairs[0][0],
                                                                      ) +
                                                                      ' ↔ ' +
                                                                      String(
                                                                        scanClashingPairs[0][1],
                                                                      ) +
                                                                      '" as a false positive — useful when one ID is a shared library required by the other (e.g. a Common dependency).'
                                                                    : 'Mark all ' +
                                                                      String(
                                                                        scanClashingPairs.length,
                                                                      ) +
                                                                      ' flagged pairs in this workshop item as false positives.'
                                                                }
                                                                className="ms-auto inline-flex items-center gap-1 rounded border border-border/50 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                                                              >
                                                                {
                                                                  'Not a conflict'
                                                                }
                                                              </button>
                                                            </DisabledReason>
                                                          </div>
                                                        )
                                                      }

                                                      if (
                                                        activeDensity !==
                                                          'detailed' &&
                                                        !isInspected
                                                      )
                                                        return null

                                                      if (
                                                        groupSiblings &&
                                                        groupSiblings.size > 0
                                                      ) {
                                                        const overlapIds =
                                                          new Set<string>()
                                                        for (const [
                                                          id,
                                                          sibs,
                                                        ] of groupSiblings)
                                                          if (sibs.size > 0)
                                                            overlapIds.add(id)
                                                        return (
                                                          <div
                                                            className="flex flex-wrap items-start gap-1 text-[11px] text-muted-foreground/70 sm:items-center"
                                                            title={
                                                              'These variants share files: ' +
                                                              String(
                                                                Array.from(
                                                                  overlapIds,
                                                                ).join(', '),
                                                              ) +
                                                              '. Enabling more than one would cause the last-loaded mod to overwrite the others. You currently have only one enabled — nothing to fix.'
                                                            }
                                                          >
                                                            <Check
                                                              aria-hidden="true"
                                                              className="mt-px h-3 w-3 shrink-0 text-success/70 sm:mt-0"
                                                            />
                                                            <span className="min-w-0 break-words">
                                                              {
                                                                'Variants share files — only one is enabled, which is the right setup.'
                                                              }
                                                            </span>
                                                          </div>
                                                        )
                                                      }
                                                      if (hasMultipleEnabled) {
                                                        return (
                                                          <div className="flex flex-wrap items-start gap-1 text-[11px] text-muted-foreground/70 sm:items-center">
                                                            <Info
                                                              aria-hidden="true"
                                                              className="mt-px h-3 w-3 shrink-0 sm:mt-0"
                                                            />
                                                            <span className="min-w-0 break-words">
                                                              {String(
                                                                enabledIds.length,
                                                              ) +
                                                                ' mod IDs enabled. If unsure whether they coexist, check the workshop page.'}
                                                            </span>
                                                            {dismissedHere.length >
                                                              0 && (
                                                              <DisabledReason
                                                                reason={
                                                                  !canManageMods
                                                                    ? 'Your role does not have permission to manage mods.'
                                                                    : null
                                                                }
                                                              >
                                                                <button
                                                                  type="button"
                                                                  onClick={(
                                                                    e,
                                                                  ) => {
                                                                    e.stopPropagation()
                                                                    for (const p of dismissedHere)
                                                                      restorePair(
                                                                        p.mod_a,
                                                                        p.mod_b,
                                                                      )
                                                                  }}
                                                                  disabled={
                                                                    !canManageMods
                                                                  }
                                                                  // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27 (rule's own shape-2 guidance): the disabled-reason branch (mods.manage) now lives in the DisabledReason wrapper above; this title carries only the always-relevant restore-dismissed hint, correctly absent rather than dead when actually disabled.
                                                                  title={
                                                                    Number(
                                                                      dismissedHere.length,
                                                                    ) === 1
                                                                      ? 'Restore ' +
                                                                        String(
                                                                          dismissedHere.length,
                                                                        ) +
                                                                        ' dismissed conflict pair for this workshop item'
                                                                      : 'Restore ' +
                                                                        String(
                                                                          dismissedHere.length,
                                                                        ) +
                                                                        ' dismissed conflict pairs for this workshop item'
                                                                  }
                                                                  className="ms-auto text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                                                                >
                                                                  {'Restore ' +
                                                                    String(
                                                                      dismissedHere.length,
                                                                    ) +
                                                                    ' dismissed'}
                                                                </button>
                                                              </DisabledReason>
                                                            )}
                                                          </div>
                                                        )
                                                      }
                                                      if (
                                                        dismissedHere.length > 0
                                                      ) {
                                                        return (
                                                          <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground/50">
                                                            <span className="min-w-0">
                                                              {Number(
                                                                dismissedHere.length,
                                                              ) === 1
                                                                ? String(
                                                                    dismissedHere.length,
                                                                  ) +
                                                                  ' dismissed conflict'
                                                                : String(
                                                                    dismissedHere.length,
                                                                  ) +
                                                                  ' dismissed conflicts'}
                                                            </span>
                                                            <DisabledReason
                                                              reason={
                                                                !canManageMods
                                                                  ? 'Your role does not have permission to manage mods.'
                                                                  : null
                                                              }
                                                            >
                                                              <button
                                                                type="button"
                                                                onClick={(
                                                                  e,
                                                                ) => {
                                                                  e.stopPropagation()
                                                                  for (const p of dismissedHere)
                                                                    restorePair(
                                                                      p.mod_a,
                                                                      p.mod_b,
                                                                    )
                                                                }}
                                                                disabled={
                                                                  !canManageMods
                                                                }
                                                                className="underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                                                              >
                                                                {'restore'}
                                                              </button>
                                                            </DisabledReason>
                                                          </div>
                                                        )
                                                      }
                                                      return null
                                                    })()}
                                                    {g.someEnabled
                                                      ? missingRequiredBlock
                                                      : null}
                                                  </>
                                                }
                                              />
                                            )
                                          })}
                                          {!filterMultiId &&
                                            orphaned
                                              .filter(
                                                (id) =>
                                                  !q ||
                                                  id.toLowerCase().includes(q),
                                              )
                                              .map((id) => (
                                                <div
                                                  key={`orphan-${id}`}
                                                  className="group flex items-center gap-3 px-3 py-1.5 opacity-60"
                                                >
                                                  <AlertTriangle className="w-3 h-3 text-warning/60 shrink-0" />
                                                  <span className="text-xs font-mono truncate flex-1">
                                                    {id}
                                                  </span>
                                                  <span className="text-[11px] text-warning/50">
                                                    {'not on disk'}
                                                  </span>
                                                  <DisabledReason
                                                    reason={
                                                      !canManageMods
                                                        ? 'Your role does not have permission to manage mods.'
                                                        : null
                                                    }
                                                  >
                                                    <button
                                                      onClick={async () => {
                                                        if (
                                                          busyRef.current ||
                                                          !canManageMods
                                                        )
                                                          return
                                                        busyRef.current = true
                                                        try {
                                                          await modsApi.toggleModId(
                                                            id,
                                                            false,
                                                          )
                                                          const updated =
                                                            await modsApi.getCurrentConfig()
                                                          setIniConfig(updated)
                                                          if (updated?.modIds)
                                                            setOrderedModIds(
                                                              updated.modIds,
                                                            )
                                                        } catch (e) {
                                                          reportClientError(
                                                            'Failed to remove orphaned mod',
                                                            e,
                                                          )
                                                          toast({
                                                            variant:
                                                              'destructive',
                                                            title:
                                                              'Failed to remove orphaned mod',
                                                          })
                                                        } finally {
                                                          busyRef.current = false
                                                        }
                                                      }}
                                                      disabled={!canManageMods}
                                                      className="text-destructive/80 hover:text-destructive hover:bg-destructive/15 rounded p-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                      // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (what removing this orphan does); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                                                      title={
                                                        'Remove orphaned mod ID ' +
                                                        String(id)
                                                      }
                                                      aria-label={
                                                        'Remove ' + String(id)
                                                      }
                                                    >
                                                      <X className="w-4 h-4" />
                                                    </button>
                                                  </DisabledReason>
                                                </div>
                                              ))}
                                        </div>
                                      </ScrollArea>
                                    ) : (
                                      <div className="space-y-2 px-3 py-8 text-center text-xs text-muted-foreground">
                                        {filterAttention &&
                                        attentionCount === 0 ? (
                                          <>
                                            <p className="text-success">
                                              {
                                                'Nothing needs attention — no clashes, missing IDs, or duplicates.'
                                              }
                                            </p>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                setFilterAttention(false)
                                              }
                                              className="underline underline-offset-2 hover:text-foreground"
                                            >
                                              {'Show all workshop items'}
                                            </button>
                                          </>
                                        ) : q ? (
                                          <p>
                                            {'No mods matching "' +
                                              String(modManagerSearch) +
                                              '"'}
                                          </p>
                                        ) : (
                                          <p>{'No mod IDs found'}</p>
                                        )}
                                      </div>
                                    )}
                                  </div>

                                  {inspectedGroup && (
                                    <aside
                                      className="rounded-lg border border-border/55 bg-card/55 shadow-md xl:sticky xl:top-3 xl:self-start"
                                      aria-label={
                                        'Selected workshop item details'
                                      }
                                    >
                                      <div className="border-b border-border/45 px-3 py-3">
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="min-w-0">
                                            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
                                              {'Selected item'}
                                            </p>
                                            <h3
                                              className="mt-1 truncate text-sm font-semibold text-foreground"
                                              title={getGroupLabel(
                                                inspectedGroup,
                                              )}
                                            >
                                              {getGroupLabel(inspectedGroup)}
                                            </h3>
                                          </div>
                                          <span
                                            className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium tabular-nums ${inspectedGroup.allEnabled ? 'border-success/30 bg-success/10 text-success' : inspectedGroup.someEnabled ? 'border-warning/35 bg-warning/10 text-warning' : 'border-border/45 bg-muted/25 text-muted-foreground'}`}
                                          >
                                            {
                                              inspectedGroup.mods.filter(
                                                (m) => m.enabled,
                                              ).length
                                            }{' '}
                                            {'of'} {inspectedGroup.mods.length}
                                          </span>
                                        </div>
                                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                          <span className="inline-flex items-center rounded border border-border/35 bg-muted/20 px-1.5 py-0.5 font-mono tabular-nums">
                                            WS {inspectedGroup.wsId}
                                          </span>
                                          {inspectedGroup.mods.length > 1 && (
                                            <span className="inline-flex items-center rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary">
                                              {'Multi-ID'}
                                            </span>
                                          )}
                                        </div>
                                      </div>

                                      <div className="space-y-3 px-3 py-3">
                                        <div className="grid grid-cols-2 gap-2">
                                          <a
                                            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${inspectedGroup.wsId}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border/55 bg-background/55 px-2 text-xs font-medium text-foreground hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                          >
                                            <ExternalLink className="h-3.5 w-3.5" />
                                            {'Workshop'}
                                          </a>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              copyText(inspectedGroup.wsId)
                                                .then(() =>
                                                  toast({
                                                    title: 'Copied',
                                                    description:
                                                      'Workshop ID ' +
                                                      String(
                                                        inspectedGroup.wsId,
                                                      ),
                                                  }),
                                                )
                                                .catch(() => {})
                                            }
                                            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border/55 bg-background/55 px-2 text-xs font-medium text-foreground hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                          >
                                            <FileText className="h-3.5 w-3.5" />
                                            {'Copy WS'}
                                          </button>
                                        </div>

                                        <div className="space-y-1.5">
                                          <div className="flex items-center justify-between gap-2">
                                            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/75">
                                              {'Loaded IDs'}
                                            </p>
                                            <DisabledReason
                                              reason={
                                                !canManageMods
                                                  ? 'Your role does not have permission to manage mods.'
                                                  : null
                                              }
                                            >
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  toggleAllInGroup(
                                                    inspectedGroup,
                                                  )
                                                }
                                                disabled={!canManageMods}
                                                className="rounded border border-border/45 bg-muted/25 px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
                                              >
                                                {inspectedGroup.allEnabled
                                                  ? 'Disable all'
                                                  : 'Enable all'}
                                              </button>
                                            </DisabledReason>
                                          </div>
                                          <div className="space-y-1.5">
                                            {inspectedGroup.mods.map((mod) => {
                                              const missing =
                                                missingDepsMap.get(mod.id) || []
                                              const isDupe =
                                                duplicateModIds.has(mod.id)
                                              return (
                                                <DisabledReason
                                                  key={mod.id}
                                                  reason={
                                                    !canManageMods
                                                      ? 'Your role does not have permission to manage mods.'
                                                      : null
                                                  }
                                                >
                                                  <button
                                                    type="button"
                                                    onClick={() =>
                                                      toggleMod(
                                                        mod,
                                                        inspectedGroup.wsId,
                                                      )
                                                    }
                                                    disabled={!canManageMods}
                                                    className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-start text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50 ${mod.enabled ? 'border-success/25 bg-success/10 text-success' : 'border-border/45 bg-muted/20 text-muted-foreground hover:text-foreground'}`}
                                                    // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27 (rule's own shape-2 guidance): the disabled-reason branch (mods.manage) now lives in the DisabledReason wrapper above; this title carries only the always-relevant click-to-toggle hint, correctly absent rather than dead when actually disabled.
                                                    title={`${mod.enabled ? 'Click to disable' : 'Click to enable'} ${mod.id}`}
                                                  >
                                                    <span
                                                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${mod.enabled ? 'bg-success' : 'bg-muted-foreground/45'}`}
                                                      aria-hidden="true"
                                                    />
                                                    <span className="min-w-0 flex-1 truncate font-mono">
                                                      {mod.id}
                                                    </span>
                                                    {missing.length > 0 && (
                                                      <AlertTriangle
                                                        className="h-3 w-3 shrink-0 text-destructive"
                                                        aria-label={
                                                          'Missing dependency'
                                                        }
                                                      />
                                                    )}
                                                    {isDupe && (
                                                      <span className="shrink-0 rounded border border-warning/35 bg-warning/10 px-1 py-0 text-[9px] uppercase tracking-wide text-warning">
                                                        dup
                                                      </span>
                                                    )}
                                                  </button>
                                                </DisabledReason>
                                              )
                                            })}
                                          </div>
                                        </div>

                                        {getGroupMissingDeps(inspectedGroup)
                                          .length > 0 && (
                                          <div className="rounded border border-destructive/35 bg-destructive/10 px-2 py-2">
                                            <div className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
                                              <AlertTriangle className="h-3.5 w-3.5" />
                                              {'Missing required IDs'}
                                            </div>
                                            <div className="mt-1.5 space-y-2">
                                              {getGroupMissingDeps(
                                                inspectedGroup,
                                              ).map((dep) => {
                                                const key = getInspectorDepKey(
                                                  inspectedGroup,
                                                  dep,
                                                )
                                                const searchOpen =
                                                  depSearchOpen.has(key)
                                                const searchState =
                                                  depSearchData[key]
                                                const adding =
                                                  depAdding.includes(key)
                                                const added =
                                                  depAddResults[key] === 'added'
                                                const errored =
                                                  depAddResults[key] === 'error'

                                                return (
                                                  <div
                                                    key={dep}
                                                    className="rounded border border-destructive/25 bg-background/25 p-1.5"
                                                  >
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                      <button
                                                        type="button"
                                                        onClick={() =>
                                                          toggleInspectorDepSearch(
                                                            inspectedGroup,
                                                            dep,
                                                          )
                                                        }
                                                        className="inline-flex items-center gap-1 rounded border border-destructive/30 bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/60"
                                                        aria-expanded={
                                                          searchOpen
                                                        }
                                                        aria-controls={`active-dep-search-${key}`}
                                                        title={
                                                          'Search Steam Workshop for ' +
                                                          String(dep)
                                                        }
                                                      >
                                                        <Search
                                                          className="h-3 w-3"
                                                          aria-hidden="true"
                                                        />
                                                        {dep}
                                                      </button>
                                                      <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        className="h-6 px-2 text-[10px]"
                                                        onClick={() => {
                                                          if (!searchOpen)
                                                            toggleInspectorDepSearch(
                                                              inspectedGroup,
                                                              dep,
                                                            )
                                                          else
                                                            runInspectorDepSearch(
                                                              inspectedGroup,
                                                              dep,
                                                              true,
                                                            )
                                                        }}
                                                        disabled={
                                                          searchState?.loading
                                                        }
                                                      >
                                                        {searchState?.loading ? (
                                                          <Loader2 className="me-1 h-3 w-3 animate-spin" />
                                                        ) : (
                                                          <Search className="me-1 h-3 w-3" />
                                                        )}
                                                        {'Find in Workshop'}
                                                      </Button>
                                                      {added && (
                                                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-success">
                                                          <Check className="h-3 w-3" />{' '}
                                                          {'Added'}
                                                        </span>
                                                      )}
                                                      {errored && (
                                                        <span className="text-[10px] font-medium text-destructive">
                                                          {'Add failed'}
                                                        </span>
                                                      )}
                                                    </div>

                                                    {searchOpen && (
                                                      <div
                                                        id={`active-dep-search-${key}`}
                                                        className="mt-2 space-y-2"
                                                      >
                                                        {searchState?.loading ? (
                                                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />{' '}
                                                            {'Searching Workshop for ' +
                                                              String(dep) +
                                                              '...'}
                                                          </div>
                                                        ) : searchState?.error ? (
                                                          <div className="flex items-center justify-between gap-2 text-[11px]">
                                                            <span className="break-words text-destructive">
                                                              {'Search failed: ' +
                                                                String(
                                                                  searchState.error,
                                                                )}
                                                            </span>
                                                            <Button
                                                              variant="ghost"
                                                              size="sm"
                                                              className="h-6 px-2 text-[10px]"
                                                              onClick={() =>
                                                                runInspectorDepSearch(
                                                                  inspectedGroup,
                                                                  dep,
                                                                  true,
                                                                )
                                                              }
                                                            >
                                                              {'Retry'}
                                                            </Button>
                                                          </div>
                                                        ) : searchState &&
                                                          searchState.results
                                                            .length === 0 ? (
                                                          <div className="space-y-1 text-[11px] text-muted-foreground">
                                                            <p>
                                                              {
                                                                'No matches found. Try the Steam search page if the dependency has a different Workshop title.'
                                                              }
                                                            </p>
                                                            {searchState.searchUrl && (
                                                              <a
                                                                href={
                                                                  searchState.searchUrl
                                                                }
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="inline-flex items-center gap-1 text-primary hover:text-primary/80"
                                                              >
                                                                <ExternalLink className="h-3 w-3" />{' '}
                                                                {
                                                                  'Open Workshop search'
                                                                }
                                                              </a>
                                                            )}
                                                          </div>
                                                        ) : searchState &&
                                                          searchState.results
                                                            .length > 0 ? (
                                                          <div className="space-y-1.5">
                                                            <p className="text-[10px] text-muted-foreground">
                                                              {
                                                                'Pick the matching Workshop item, then add it to the server config.'
                                                              }
                                                            </p>
                                                            {searchState.results
                                                              .slice(0, 4)
                                                              .map(
                                                                (
                                                                  hit,
                                                                  hitIndex,
                                                                ) => {
                                                                  const isBest =
                                                                    hit.matchType ===
                                                                      'exact-id' ||
                                                                    hitIndex ===
                                                                      0
                                                                  return (
                                                                    <div
                                                                      key={`${dep}-${hit.workshopId}-${hit.modId || ''}`}
                                                                      className={`rounded border px-2 py-1.5 ${isBest ? 'border-success/35 bg-success/[0.055]' : 'border-border/40 bg-card/45'}`}
                                                                    >
                                                                      <div className="flex items-start justify-between gap-2">
                                                                        <div className="min-w-0">
                                                                          <div className="flex min-w-0 items-center gap-1.5">
                                                                            <p
                                                                              className="truncate text-[11px] font-medium text-foreground"
                                                                              title={
                                                                                hit.modName
                                                                              }
                                                                            >
                                                                              {
                                                                                hit.modName
                                                                              }
                                                                            </p>
                                                                            {isBest && (
                                                                              <span className="shrink-0 rounded border border-success/35 bg-success/10 px-1 py-0 text-[9px] font-semibold uppercase tracking-wide text-success">
                                                                                {
                                                                                  'Best'
                                                                                }
                                                                              </span>
                                                                            )}
                                                                          </div>
                                                                          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                                                                            <span className="font-mono">
                                                                              WS{' '}
                                                                              {
                                                                                hit.workshopId
                                                                              }
                                                                            </span>
                                                                            {hit.modId && (
                                                                              <span className="font-mono">
                                                                                ID{' '}
                                                                                {
                                                                                  hit.modId
                                                                                }
                                                                              </span>
                                                                            )}
                                                                            <span>
                                                                              {hit.source ===
                                                                              'local'
                                                                                ? 'local'
                                                                                : 'Steam'}
                                                                            </span>
                                                                            {hit.matchType ===
                                                                              'exact-id' && (
                                                                              <span className="text-success">
                                                                                {
                                                                                  'exact ID'
                                                                                }
                                                                              </span>
                                                                            )}
                                                                          </p>
                                                                        </div>
                                                                        <div className="flex shrink-0 items-center gap-1">
                                                                          <a
                                                                            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${hit.workshopId}`}
                                                                            target="_blank"
                                                                            rel="noopener noreferrer"
                                                                            className="rounded p-1 text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                                                                            aria-label={
                                                                              'Open ' +
                                                                              String(
                                                                                hit.modName,
                                                                              ) +
                                                                              ' on Steam Workshop'
                                                                            }
                                                                          >
                                                                            <ExternalLink className="h-3.5 w-3.5" />
                                                                          </a>
                                                                          <Button
                                                                            type="button"
                                                                            variant="outline"
                                                                            size="sm"
                                                                            className="h-6 px-2 text-[10px]"
                                                                            onClick={() =>
                                                                              handleInspectorAddDep(
                                                                                hit,
                                                                                dep,
                                                                                key,
                                                                              )
                                                                            }
                                                                            disabled={
                                                                              adding ||
                                                                              added ||
                                                                              !canManageMods
                                                                            }
                                                                          >
                                                                            {adding ? (
                                                                              <Loader2 className="me-1 h-3 w-3 animate-spin" />
                                                                            ) : added ? (
                                                                              <Check className="me-1 h-3 w-3" />
                                                                            ) : (
                                                                              <Plus className="me-1 h-3 w-3" />
                                                                            )}
                                                                            {added
                                                                              ? 'Added'
                                                                              : 'Add'}
                                                                          </Button>
                                                                        </div>
                                                                      </div>
                                                                    </div>
                                                                  )
                                                                },
                                                              )}
                                                            {searchState.searchUrl && (
                                                              <a
                                                                href={
                                                                  searchState.searchUrl
                                                                }
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80"
                                                              >
                                                                <ExternalLink className="h-3 w-3" />{' '}
                                                                {
                                                                  'Open full Workshop search'
                                                                }
                                                              </a>
                                                            )}
                                                          </div>
                                                        ) : null}
                                                      </div>
                                                    )}
                                                  </div>
                                                )
                                              })}
                                            </div>
                                          </div>
                                        )}

                                        {getGroupDuplicateIds(inspectedGroup)
                                          .length > 0 && (
                                          <div className="rounded border border-warning/35 bg-warning/10 px-2 py-2">
                                            <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
                                              <AlertTriangle className="h-3.5 w-3.5" />
                                              {'Duplicate internal IDs'}
                                            </div>
                                            <div className="mt-1.5 flex flex-wrap gap-1">
                                              {getGroupDuplicateIds(
                                                inspectedGroup,
                                              ).map((id) => (
                                                <span
                                                  key={id}
                                                  className="rounded border border-warning/30 bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] text-warning"
                                                >
                                                  {id}
                                                </span>
                                              ))}
                                            </div>
                                          </div>
                                        )}

                                        <div className="border-t border-border/35 pt-3">
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                                            onClick={() =>
                                              setConfirmRemoveWorkshop({
                                                wsId: inspectedGroup.wsId,
                                                knownModIds:
                                                  inspectedGroup.mods.map(
                                                    (m) => m.id,
                                                  ),
                                              })
                                            }
                                            disabled={!canManageMods}
                                          >
                                            <Trash2 className="me-2 h-3.5 w-3.5" />
                                            {'Remove from server INI'}
                                          </Button>
                                        </div>
                                      </div>
                                    </aside>
                                  )}
                                </div>

                                <details className="pt-2 border-t border-border/20 group/raw">
                                  <summary className="text-[11px] text-muted-foreground/60 hover:text-foreground cursor-pointer select-none list-none flex items-center gap-1 transition-colors">
                                    <ChevronRight
                                      className="w-3 h-3 transition-transform group-open/raw:rotate-90"
                                      aria-hidden="true"
                                    />
                                    <>
                                      {'Show raw '}
                                      <span className="font-mono">
                                        {'Mods='}
                                      </span>
                                      {' line'}
                                    </>
                                  </summary>
                                  <div
                                    className="text-[11px] text-muted-foreground font-mono break-all leading-tight mt-1.5"
                                    title={`Mods=${iniConfig.modIds?.join(';') || ''}`}
                                  >
                                    Mods={iniConfig.modIds?.join(';') || ''}
                                  </div>
                                </details>

                                <AlertDialog
                                  open={!!confirmRemoveWorkshop}
                                  onOpenChange={(open) => {
                                    if (!open) setConfirmRemoveWorkshop(null)
                                  }}
                                >
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>
                                        {'Remove workshop item?'}
                                      </AlertDialogTitle>
                                      <AlertDialogDescription>
                                        {
                                          "This will remove the workshop item and its mod IDs from the server INI. Workshop files on disk won't be deleted."
                                        }
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>
                                        {'Cancel'}
                                      </AlertDialogCancel>
                                      <AlertDialogAction
                                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        onClick={handleConfirmedRemoveWorkshop}
                                        disabled={!canManageMods}
                                      >
                                        {'Remove'}
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </div>
                            )
                          })()}

                        {configSubTab === 'order' &&
                          (() => {
                            const modIdNameMap = new Map<string, string>()
                            const modIdWsMap = new Map<string, string>()
                            const wsMap = iniConfig?.workshopModMap || {}
                            for (const [wsId, details] of Object.entries(
                              wsMap,
                            )) {
                              for (const m of details) {
                                if (m.name && m.name !== m.id)
                                  modIdNameMap.set(m.id, m.name)
                                modIdWsMap.set(m.id, wsId)
                              }
                            }
                            for (const mod of mods) {
                              const details = wsMap[mod.workshop_id]
                              if (details) {
                                for (const m of details) {
                                  if (!modIdNameMap.has(m.id) && mod.name)
                                    modIdNameMap.set(m.id, mod.name)
                                }
                              }
                            }

                            return (
                              <div className="space-y-3 sub-tab-enter">
                                {orderedModIds.length === 0 ? (
                                  <div className="flex items-center justify-center py-10 text-muted-foreground">
                                    <div className="text-center space-y-2">
                                      <Layers className="w-8 h-8 mx-auto opacity-30" />
                                      <p className="text-sm font-medium text-foreground/70">
                                        {'No mods in load order'}
                                      </p>
                                      <p className="text-xs">
                                        {
                                          'Enable mods in the Active Mods tab first.'
                                        }
                                      </p>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="flex items-center justify-between gap-3 flex-wrap">
                                      <p className="text-xs text-muted-foreground">
                                        {
                                          'Drag to reorder. Changes are not saved until you click Save.'
                                        }
                                      </p>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-8 text-xs"
                                        onClick={handleAutoSort}
                                        disabled={
                                          savingModOrder || !!autoSortPreview
                                        }
                                      >
                                        <Wand2 className="w-3 h-3 me-1" />
                                        {'Auto-sort by dependencies'}
                                      </Button>
                                    </div>

                                    {autoSortPreview && (
                                      <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
                                        <div className="flex items-center justify-between gap-3 flex-wrap">
                                          <div className="space-y-0.5">
                                            <p className="text-xs font-medium text-foreground">
                                              {autoSortPreview.moved.length ===
                                              1
                                                ? 'Proposed order: ' +
                                                  String(
                                                    autoSortPreview.moved
                                                      .length,
                                                  ) +
                                                  ' mod would move'
                                                : 'Proposed order: ' +
                                                  String(
                                                    autoSortPreview.moved
                                                      .length,
                                                  ) +
                                                  ' mods would move'}
                                            </p>
                                            <p className="text-[11px] text-muted-foreground">
                                              {autoSortPreview.appliedEdges ===
                                              1
                                                ? 'Based on ' +
                                                  String(
                                                    autoSortPreview.appliedEdges,
                                                  ) +
                                                  ' dependency declared in mod.info. Mods with no dependency keep your order.'
                                                : 'Based on ' +
                                                  String(
                                                    autoSortPreview.appliedEdges,
                                                  ) +
                                                  ' dependencies declared in mod.info. Mods with no dependency keep your order.'}
                                            </p>
                                          </div>
                                          <div className="flex gap-2">
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              className="h-8 text-xs"
                                              onClick={() =>
                                                setAutoSortPreview(null)
                                              }
                                            >
                                              {'Cancel'}
                                            </Button>
                                            <Button
                                              size="sm"
                                              className="h-8 text-xs"
                                              onClick={applyAutoSort}
                                            >
                                              {'Apply'}
                                            </Button>
                                          </div>
                                        </div>

                                        <ScrollArea className="max-h-40">
                                          <div className="space-y-0.5 pe-2">
                                            {autoSortPreview.moved.map(
                                              (move) => (
                                                <div
                                                  key={move.modId}
                                                  className="flex items-center gap-2 text-[11px]"
                                                >
                                                  <span className="tabular-nums text-muted-foreground w-8 text-end shrink-0">
                                                    #{move.from}
                                                  </span>
                                                  <ArrowRight className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                                                  <span className="tabular-nums text-primary w-8 text-end shrink-0">
                                                    #{move.to}
                                                  </span>
                                                  <span className="font-mono truncate shrink-0">
                                                    {move.modId}
                                                  </span>
                                                  {modIdNameMap.get(
                                                    move.modId,
                                                  ) && (
                                                    <span className="text-muted-foreground/60 truncate">
                                                      {modIdNameMap.get(
                                                        move.modId,
                                                      )}
                                                    </span>
                                                  )}
                                                </div>
                                              ),
                                            )}
                                          </div>
                                        </ScrollArea>

                                        {autoSortPreview.cycles.length > 0 && (
                                          <div className="space-y-0.5">
                                            {autoSortPreview.cycles.map(
                                              (group) => (
                                                <p
                                                  key={group.join('|')}
                                                  className="text-[11px] text-warning"
                                                >
                                                  {'Circular dependency between ' +
                                                    String(group.join(', ')) +
                                                    '. No order can satisfy it, so these keep their current order relative to each other.'}
                                                </p>
                                              ),
                                            )}
                                          </div>
                                        )}
                                        {autoSortPreview.missing.length > 0 && (
                                          <p className="text-[11px] text-muted-foreground">
                                            {autoSortPreview.missing.length ===
                                            1
                                              ? String(
                                                  autoSortPreview.missing
                                                    .length,
                                                ) +
                                                ' required mod is not enabled and could not be ordered (see the Conflicts tab).'
                                              : String(
                                                  autoSortPreview.missing
                                                    .length,
                                                ) +
                                                ' required mods are not enabled and could not be ordered (see the Conflicts tab).'}
                                          </p>
                                        )}
                                      </div>
                                    )}
                                    <div className="rounded-lg border border-border bg-muted/50 shadow-md overflow-hidden">
                                      <ScrollArea className="h-[calc(100vh-320px)] min-h-[200px]">
                                        <div className="divide-y divide-border/60 [&>*:nth-child(even)]:bg-card/70">
                                          {orderedModIds
                                            .map((modId, idx) => ({
                                              modId,
                                              idx,
                                            }))
                                            .filter(({ modId }) => {
                                              const q = deferredModManagerSearch
                                                .toLowerCase()
                                                .trim()
                                              if (!q) return true
                                              if (
                                                modId.toLowerCase().includes(q)
                                              )
                                                return true
                                              const name =
                                                modIdNameMap.get(modId)
                                              return name
                                                ? name.toLowerCase().includes(q)
                                                : false
                                            })
                                            .map(({ modId, idx }) => {
                                              const displayName =
                                                modIdNameMap.get(modId)
                                              return (
                                                <div
                                                  key={`${modId}-${idx}`}
                                                  draggable={
                                                    !modManagerSearch.trim()
                                                  }
                                                  onDragStart={() =>
                                                    handleDragStart(idx)
                                                  }
                                                  onDragOver={(e) =>
                                                    handleDragOver(e, idx)
                                                  }
                                                  onDragEnd={handleDragEnd}
                                                  className={`flex items-center gap-2 px-2.5 py-1 cursor-move transition-colors duration-150 hover:bg-muted/15 ${
                                                    draggedModIndex === idx
                                                      ? 'opacity-30 bg-primary/5'
                                                      : ''
                                                  }`}
                                                >
                                                  <GripVertical className="w-3 h-3 text-muted-foreground/30 shrink-0" />
                                                  <span className="text-[11px] tabular-nums text-muted-foreground w-5 text-end shrink-0">
                                                    {idx + 1}
                                                  </span>
                                                  <span className="text-[11px] font-mono truncate shrink-0">
                                                    {modId}
                                                  </span>
                                                  {displayName && (
                                                    <span className="text-[11px] text-muted-foreground/60 truncate flex-1">
                                                      {displayName}
                                                    </span>
                                                  )}
                                                  {!displayName && (
                                                    <span className="flex-1" />
                                                  )}
                                                  <div className="flex shrink-0">
                                                    <button
                                                      onClick={() =>
                                                        moveModUp(idx)
                                                      }
                                                      disabled={idx === 0}
                                                      className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-muted/30 disabled:opacity-30 rounded transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                                                      aria-label={'Move up'}
                                                    >
                                                      <ChevronRight className="w-3.5 h-3.5 -rotate-90" />
                                                    </button>
                                                    <button
                                                      onClick={() =>
                                                        moveModDown(idx)
                                                      }
                                                      disabled={
                                                        idx ===
                                                        orderedModIds.length - 1
                                                      }
                                                      className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-muted/30 disabled:opacity-30 rounded transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                                                      aria-label={'Move down'}
                                                    >
                                                      <ChevronRight className="w-3.5 h-3.5 rotate-90" />
                                                    </button>
                                                  </div>
                                                </div>
                                              )
                                            })}
                                        </div>
                                      </ScrollArea>
                                      {hasModOrderChanged && (
                                        <div className="px-3 py-2 border-t border-border/40 bg-muted/20 flex items-center justify-between">
                                          <span className="text-[11px] text-warning">
                                            {'Unsaved order changes'}
                                          </span>
                                          <div className="flex gap-2">
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              className="h-8 text-xs"
                                              onClick={() => {
                                                setAutoSortPreview(null)
                                                setOrderedModIds(
                                                  iniConfig.modIds,
                                                )
                                              }}
                                            >
                                              {'Reset'}
                                            </Button>
                                            <Button
                                              size="sm"
                                              className="h-8 text-xs"
                                              onClick={handleSaveModOrder}
                                              disabled={
                                                savingModOrder ||
                                                !canManageMods ||
                                                serverChangedSinceLoad
                                              }
                                            >
                                              {savingModOrder ? (
                                                <Loader2 className="w-3 h-3 me-1 animate-spin" />
                                              ) : (
                                                <Save className="w-3 h-3 me-1" />
                                              )}
                                              {'Save Order'}
                                            </Button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )
                          })()}

                        {configSubTab === 'add' && (
                          <div className="space-y-4 sub-tab-enter">
                            <div className="flex flex-col gap-3 rounded-lg border border-border/70 bg-secondary p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0">
                                <p className="text-sm font-medium">
                                  {'Sync Mod IDs from Downloads'}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {
                                    'Reads mod.info from downloaded mods and adds their IDs to Mods= in the INI'
                                  }
                                </p>
                              </div>
                              <Button
                                onClick={handleSyncModIds}
                                disabled={syncing || !canManageMods}
                                size="sm"
                                variant="outline"
                              >
                                {syncing ? (
                                  <RefreshCw className="w-4 h-4 me-2 animate-spin" />
                                ) : (
                                  <RefreshCw className="w-4 h-4 me-2" />
                                )}
                                {'Sync Mod IDs'}
                              </Button>
                            </div>

                            {modsToInstall.length > 0 && (
                              <div className="space-y-3 rounded-lg border border-border/70 bg-secondary p-3">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                  <Label className="flex items-center gap-2">
                                    <Plus className="w-4 h-4" />
                                    {modsToInstall.length === 1
                                      ? String(modsToInstall.length) +
                                        ' mod queued for INI'
                                      : String(modsToInstall.length) +
                                        ' mods queued for INI'}
                                  </Label>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setModsToInstall([])}
                                  >
                                    {'Clear All'}
                                  </Button>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {modsToInstall.map((mod) => (
                                    <Badge
                                      key={mod.workshopId}
                                      variant="outline"
                                      className="max-w-full text-xs sm:max-w-[200px]"
                                    >
                                      <span className="truncate">
                                        {mod.name}
                                      </span>
                                      {mod.isMap && (
                                        <MapIcon className="w-3 h-3 ms-1" />
                                      )}
                                      <button
                                        type="button"
                                        aria-label={
                                          'Remove ' +
                                          String(mod.name) +
                                          ' from queue'
                                        }
                                        onClick={() =>
                                          removeFromInstallList(mod.workshopId)
                                        }
                                        className="ms-1 hover:text-destructive"
                                      >
                                        ×
                                      </button>
                                    </Badge>
                                  ))}
                                </div>
                                <Button
                                  onClick={handleWriteToIni}
                                  disabled={loading || !canManageMods}
                                  size="sm"
                                >
                                  <FileText className="w-4 h-4 me-2" />
                                  {'Write to Server INI'}
                                </Button>
                              </div>
                            )}

                            {modsToInstall.length === 0 && (
                              <div className="text-center py-8 text-muted-foreground">
                                <Plus className="w-10 h-10 mx-auto mb-3 opacity-30" />
                                <p className="text-sm">{'No mods pending'}</p>
                                <p className="text-xs">
                                  {
                                    'Use the Server Mods tab to find and add new workshop items, or click Sync to detect new downloads.'
                                  }
                                </p>
                              </div>
                            )}
                          </div>
                        )}

                        {configSubTab === 'presets' && (
                          <div className="space-y-4 sub-tab-enter">
                            <div className="flex items-center justify-between">
                              <p className="text-xs text-muted-foreground">
                                {'Save and restore mod configurations.'}
                              </p>
                              <DisabledReason
                                reason={
                                  !canManageMods
                                    ? 'Your role does not have permission to manage mods.'
                                    : null
                                }
                              >
                                <Dialog
                                  open={savePresetOpen}
                                  onOpenChange={setSavePresetOpen}
                                >
                                  <DialogTrigger asChild>
                                    <Button
                                      size="sm"
                                      disabled={
                                        !iniConfig?.configured || !canManageMods
                                      }
                                    >
                                      <Save className="w-4 h-4 me-2" />
                                      {'Save Current'}
                                    </Button>
                                  </DialogTrigger>
                                  <DialogContent>
                                    <DialogHeader>
                                      <DialogTitle>
                                        {'Save Mod Preset'}
                                      </DialogTitle>
                                      <DialogDescription>
                                        {
                                          'Save the current mod configuration as a preset for easy switching later.'
                                        }
                                      </DialogDescription>
                                    </DialogHeader>
                                    <div className="space-y-4">
                                      <div className="space-y-2">
                                        <Label htmlFor="presetName">
                                          {'Preset Name'}
                                        </Label>
                                        <Input
                                          id="presetName"
                                          value={presetName}
                                          onChange={(e) =>
                                            setPresetName(e.target.value)
                                          }
                                          placeholder={
                                            'e.g., Vanilla+ Light, Hardcore, RP Server'
                                          }
                                          maxLength={100}
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <Label htmlFor="presetDesc">
                                          {'Description (optional)'}
                                        </Label>
                                        <Input
                                          id="presetDesc"
                                          value={presetDescription}
                                          onChange={(e) =>
                                            setPresetDescription(e.target.value)
                                          }
                                          placeholder={
                                            'Brief description of this preset...'
                                          }
                                          maxLength={500}
                                        />
                                      </div>
                                      {iniConfig?.configured && (
                                        <div className="rounded-lg border border-border/70 bg-secondary p-3 text-sm text-muted-foreground">
                                          {'This will save ' +
                                            String(
                                              iniConfig.workshopIds?.length ||
                                                0,
                                            ) +
                                            ' workshop items and ' +
                                            String(
                                              iniConfig.modIds?.length || 0,
                                            ) +
                                            ' mod IDs.'}
                                        </div>
                                      )}
                                    </div>
                                    <DialogFooter className="flex-col sm:flex-row gap-2">
                                      <Button
                                        variant="outline"
                                        onClick={() => setSavePresetOpen(false)}
                                        className="w-full sm:w-auto"
                                      >
                                        {'Cancel'}
                                      </Button>
                                      <Button
                                        onClick={handleSavePreset}
                                        disabled={
                                          savingPreset ||
                                          !presetName.trim() ||
                                          !canManageMods
                                        }
                                        className="w-full sm:w-auto"
                                      >
                                        {savingPreset && (
                                          <Loader2 className="w-4 h-4 me-2 animate-spin" />
                                        )}
                                        {'Save Preset'}
                                      </Button>
                                    </DialogFooter>
                                  </DialogContent>
                                </Dialog>
                              </DisabledReason>
                            </div>

                            {presetsLoading ? (
                              <div className="flex items-center justify-center py-8">
                                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                              </div>
                            ) : presets.length === 0 ? (
                              <div className="text-center py-8 text-muted-foreground">
                                <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
                                <p className="text-sm">
                                  {'No presets saved yet'}
                                </p>
                                <p className="text-xs">
                                  {
                                    'Save your current mod configuration to create a preset'
                                  }
                                </p>
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {presets.map((preset) => (
                                  <div
                                    key={preset.id}
                                    className="flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/50 p-3 transition-colors hover:bg-accent/20 sm:flex-row sm:items-center sm:justify-between"
                                  >
                                    <div className="flex-1 min-w-0">
                                      <div className="font-medium truncate">
                                        {preset.name}
                                      </div>
                                      <div className="text-xs text-muted-foreground truncate">
                                        {String(
                                          preset.workshop_ids?.length || 0,
                                        ) + ' mods'}{' '}
                                        &bull;{' '}
                                        {preset.description || 'No description'}
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        {'Saved ' +
                                          String(
                                            new Date(
                                              preset.created_at,
                                            ).toLocaleDateString('en'),
                                          )}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2 self-start sm:self-auto">
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          setConfirmApplyPreset({
                                            id: preset.id,
                                            name: preset.name,
                                            modCount:
                                              preset.workshop_ids?.length || 0,
                                          })
                                        }
                                        disabled={applyingPreset === preset.id}
                                      >
                                        {applyingPreset === preset.id ? (
                                          <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : (
                                          <Download className="w-4 h-4" />
                                        )}
                                        <span className="ms-1.5">{'Load'}</span>
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                          setConfirmDeletePreset({
                                            id: preset.id,
                                            name: preset.name,
                                          })
                                        }
                                        className="text-destructive hover:text-destructive"
                                        aria-label={
                                          'Delete preset "' +
                                          String(preset.name) +
                                          '"'
                                        }
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            <AlertDialog
                              open={!!confirmApplyPreset}
                              onOpenChange={(open) => {
                                if (!open) setConfirmApplyPreset(null)
                              }}
                            >
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    {'Apply preset "' +
                                      String(confirmApplyPreset?.name) +
                                      '"?'}
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {'This will replace your current mod configuration with ' +
                                      String(
                                        confirmApplyPreset?.modCount || 0,
                                      ) +
                                      ' mods from this preset. Your existing Mods= and WorkshopItems= lines will be overwritten.'}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>
                                    {'Cancel'}
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => {
                                      if (confirmApplyPreset) {
                                        handleApplyPreset(
                                          confirmApplyPreset.id,
                                          confirmApplyPreset.name,
                                        )
                                        setConfirmApplyPreset(null)
                                      }
                                    }}
                                    disabled={!canManageMods}
                                  >
                                    {'Apply Preset'}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>

                            <AlertDialog
                              open={!!confirmDeletePreset}
                              onOpenChange={(open) => {
                                if (!open) setConfirmDeletePreset(null)
                              }}
                            >
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    {'Delete preset "' +
                                      String(confirmDeletePreset?.name) +
                                      '"?'}
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {
                                      'This preset will be permanently deleted. This action cannot be undone.'
                                    }
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>
                                    {'Cancel'}
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    onClick={() => {
                                      if (confirmDeletePreset) {
                                        handleDeletePreset(
                                          confirmDeletePreset.id,
                                          confirmDeletePreset.name,
                                        )
                                        setConfirmDeletePreset(null)
                                      }
                                    }}
                                    disabled={!canManageMods}
                                  >
                                    {'Delete Preset'}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        )}

                        {configSubTab === 'tools' && (
                          <div className="space-y-4 sub-tab-enter">
                            <div className="rounded-lg border border-border/40 p-3 space-y-2">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                  <MapIcon className="w-4 h-4" />
                                  {'Maps= (' +
                                    String(iniConfig?.maps?.length || 0) +
                                    ')'}
                                </div>
                                <DisabledReason
                                  reason={
                                    !canManageMods
                                      ? 'Your role does not have permission to manage mods.'
                                      : null
                                  }
                                >
                                  <button
                                    onClick={async () => {
                                      if (!canManageMods) return
                                      try {
                                        setRepairingMaps(true)
                                        const result =
                                          await modsApi.repairMapEntries()
                                        setMapRepairResult(result)
                                      } catch (err) {
                                        reportClientError(
                                          'Map repair failed.',
                                          err,
                                        )
                                        setMapRepairResult({
                                          removed: [],
                                          remaining: iniConfig?.maps || [],
                                          message:
                                            'Map repair failed — check server connection',
                                        })
                                      } finally {
                                        setRepairingMaps(false)
                                      }
                                    }}
                                    disabled={repairingMaps || !canManageMods}
                                    className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-muted hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors disabled:opacity-50"
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint describing what the button does; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                                    title={
                                      'Validate and remove invalid map entries'
                                    }
                                  >
                                    {repairingMaps ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Wrench className="w-3 h-3" />
                                    )}
                                    {'Repair'}
                                  </button>
                                </DisabledReason>
                              </div>
                              {mapRepairResult && (
                                <div
                                  className={`p-2 rounded text-xs ${mapRepairResult.removed.length > 0 || (mapRepairResult.added?.length ?? 0) > 0 ? 'bg-warning/10 text-warning border border-warning/20' : 'bg-success/10 text-success border border-success/20'}`}
                                >
                                  {mapRepairResult.message}
                                </div>
                              )}
                              <div className="flex flex-wrap gap-1">
                                {iniConfig.maps.map((map, i) => (
                                  <Badge
                                    key={i}
                                    variant="secondary"
                                    className="text-xs max-w-[250px] truncate"
                                  >
                                    {map}
                                  </Badge>
                                ))}
                              </div>
                            </div>

                            <div className="rounded-lg border border-border/40 p-3 space-y-2">
                              <div className="flex items-center gap-2 text-sm font-medium">
                                <Package className="w-4 h-4" />
                                {'WorkshopItems= (' +
                                  String(iniConfig.workshopIds?.length || 0) +
                                  ')'}
                              </div>
                              <div className="flex flex-wrap gap-1 max-h-[200px] overflow-y-auto">
                                {iniConfig.workshopIds?.map((id, i) => (
                                  <Badge
                                    key={i}
                                    variant="outline"
                                    className="text-xs font-mono max-w-[140px] truncate"
                                  >
                                    {id}
                                  </Badge>
                                ))}
                              </div>
                              <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded font-mono break-all max-h-[80px] overflow-y-auto">
                                WorkshopItems=
                                {iniConfig.workshopIds?.join(';') || ''}
                              </div>
                            </div>

                            <div className="rounded-lg border border-border/40 p-3 space-y-3 text-sm text-muted-foreground">
                              <div className="text-xs font-semibold text-foreground flex items-center gap-2">
                                <Info className="w-3.5 h-3.5" />
                                {'Operator Notes'}
                              </div>
                              <div className="flex items-start gap-3">
                                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-warning shrink-0" />
                                <div>
                                  <p className="font-medium text-foreground text-xs">
                                    {'Load Order Matters'}
                                  </p>
                                  <p className="text-xs">
                                    {
                                      'Frameworks and dependencies must load before content mods. Wrong order can cause silent failures.'
                                    }
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-start gap-3">
                                <MapIcon className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                                <div>
                                  <p className="font-medium text-foreground text-xs">
                                    {'Map Mods Need Extra Care'}
                                  </p>
                                  <p className="text-xs">
                                    {
                                      'After importing map mods, verify map folder names so spawns and cells load correctly.'
                                    }
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-start gap-3">
                                <RefreshCw className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                                <div>
                                  <p className="font-medium text-foreground text-xs">
                                    {'Sync After Downloading New Mods'}
                                  </p>
                                  <p className="text-xs">
                                    {
                                      "Workshop items without matching mod IDs usually means Steam hasn't finished downloading."
                                    }
                                  </p>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-center py-8">
                        <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                        <p className="text-muted-foreground">
                          {iniConfig?.error || 'Server config file not found'}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {
                            'Start the server once — it will create the INI file automatically.'
                          }
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'conflicts' && (
                  <ConflictsPanel
                    conflicts={conflicts}
                    focusDependencies={reviewUnresolved}
                    conflictsLoading={conflictsLoading}
                    conflictsError={conflictsError}
                    conflictsStale={conflictsStale}
                    lastScanTime={lastScanTime}
                    scanConflicts={scanConflicts}
                    scanProgress={scanProgress}
                    scanCurrentMod={scanCurrentMod}
                    scanModsScanned={scanModsScanned}
                    scanTotalMods={scanTotalMods}
                    streamConflicts={streamConflicts}
                    fetchData={fetchData}
                    busyRef={busyRef}
                    savingModOrder={savingModOrder}
                    promoteModOverOpponent={promoteModOverOpponent}
                    toast={toast}
                    depSearchOpen={depSearchOpen}
                    setDepSearchOpen={setDepSearchOpen}
                    depSearchData={depSearchData}
                    setDepSearchData={setDepSearchData}
                    depAdding={depAdding}
                    setDepAdding={setDepAdding}
                    depAddResults={depAddResults}
                    setDepAddResults={setDepAddResults}
                  />
                )}

                {activeTab === 'collection' && (
                  <div className="space-y-4">
                    <WorkshopCollectionPanel />
                  </div>
                )}

                {activeTab === 'deactivated' && (
                  <div className="space-y-4">
                    <Card>
                      <CardHeader className="pb-3">
                        <div className="flex items-center gap-2">
                          <EyeOff className="w-4 h-4 text-muted-foreground" />
                          <CardTitle className="text-base">
                            {'Deactivated Mods'}
                          </CardTitle>
                          <Badge
                            variant="outline"
                            className="font-mono text-[11px] tabular-nums"
                          >
                            {groupedMods.deactivated.length}
                          </Badge>
                        </div>
                        <CardDescription>
                          <>
                            {
                              "Tracked by the panel but not present in the server INI's "
                            }
                            <code className="text-[11px]">
                              {'WorkshopItems='}
                            </code>
                            {
                              " list. They won't be loaded by the server. Re-enable to put them back into the INI, or delete to stop tracking entirely."
                            }
                          </>
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="p-0">
                        {!iniConfig ? (
                          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                            {'Loading server config…'}
                          </div>
                        ) : groupedMods.deactivated.length === 0 ? (
                          <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
                            <CheckCircle className="w-8 h-8 text-muted-foreground/40" />
                            <p className="text-sm text-muted-foreground">
                              {'No deactivated mods.'}
                            </p>
                            <p className="text-xs text-muted-foreground/70 max-w-md">
                              {
                                "Every tracked mod is referenced in the server INI's WorkshopItems= list."
                              }
                            </p>
                          </div>
                        ) : (
                          <>
                            {(() => {
                              const deactivatedIds =
                                groupedMods.deactivated.map(
                                  (m) => m.workshop_id,
                                )
                              const selectedDeactivated = deactivatedIds.filter(
                                (id) => selectedMods.has(id),
                              )
                              const allSelected =
                                selectedDeactivated.length ===
                                  deactivatedIds.length &&
                                deactivatedIds.length > 0
                              const someSelected =
                                selectedDeactivated.length > 0
                              const missingNameCount =
                                groupedMods.deactivated.filter(
                                  (m) =>
                                    !m.name || /^Workshop Mod /i.test(m.name),
                                ).length
                              return (
                                <div className="space-y-2 border-b border-border/40 bg-muted/15 px-4 py-2.5">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="flex items-center gap-2">
                                      <Checkbox
                                        checked={allSelected}
                                        onCheckedChange={(checked) => {
                                          setSelectedMods((prev) => {
                                            const next = new Set(prev)
                                            if (checked) {
                                              for (const id of deactivatedIds)
                                                next.add(id)
                                            } else {
                                              for (const id of deactivatedIds)
                                                next.delete(id)
                                            }
                                            return next
                                          })
                                        }}
                                        aria-label={
                                          'Select all deactivated mods'
                                        }
                                      />
                                      <span className="text-xs text-muted-foreground">
                                        {someSelected
                                          ? String(selectedDeactivated.length) +
                                            ' selected'
                                          : 'Select all (' +
                                            String(deactivatedIds.length) +
                                            ')'}
                                      </span>
                                    </div>
                                    <div className="ms-auto flex items-center gap-2">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={
                                          !someSelected ||
                                          loading ||
                                          !canManageMods
                                        }
                                        onClick={() =>
                                          handleBulkEnable(selectedDeactivated)
                                        }
                                      >
                                        <PlusCircle className="w-4 h-4 me-1.5" />
                                        {someSelected
                                          ? 'Re-enable (' +
                                            String(selectedDeactivated.length) +
                                            ')'
                                          : 'Re-enable'}
                                      </Button>
                                    </div>
                                  </div>
                                  <details className="group/deactivated-danger rounded border border-border/35 bg-card/35 px-2.5 py-1.5">
                                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] text-muted-foreground hover:text-foreground">
                                      <span className="inline-flex items-center gap-1.5">
                                        <ChevronRight
                                          className="h-3 w-3 transition-transform group-open/deactivated-danger:rotate-90"
                                          aria-hidden="true"
                                        />
                                        {'Tracking cleanup'}
                                      </span>
                                      <span className="text-muted-foreground/65">
                                        {'config only, files stay on disk'}
                                      </span>
                                    </summary>
                                    <div className="mt-2 flex flex-col gap-2 border-t border-border/25 pt-2 sm:flex-row sm:items-center sm:justify-between">
                                      <p className="text-[11px] leading-4 text-muted-foreground">
                                        {
                                          'Delete only removes panel tracking. Workshop files stay on disk, but you will need to add the mod manually later.'
                                        }
                                      </p>
                                      <DisabledReason
                                        reason={
                                          !canManageMods
                                            ? 'Your role does not have permission to manage mods.'
                                            : null
                                        }
                                      >
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="self-start sm:self-auto"
                                          disabled={
                                            loading ||
                                            deactivatedIds.length === 0 ||
                                            !canManageMods
                                          }
                                          onClick={async () => {
                                            if (!canManageMods) return
                                            const ids = someSelected
                                              ? selectedDeactivated
                                              : deactivatedIds
                                            const label = someSelected
                                              ? ids.length === 1
                                                ? 'Remove ' +
                                                  String(ids.length) +
                                                  ' selected deactivated mod from tracking? The workshop files stay on disk -- you can re-add it later.'
                                                : 'Remove ' +
                                                  String(ids.length) +
                                                  ' selected deactivated mods from tracking? The workshop files stay on disk -- you can re-add them later.'
                                              : ids.length === 1
                                                ? 'Remove ALL ' +
                                                  String(ids.length) +
                                                  ' deactivated mod from tracking? The workshop files stay on disk -- you can re-add it later.'
                                                : 'Remove ALL ' +
                                                  String(ids.length) +
                                                  ' deactivated mods from tracking? The workshop files stay on disk -- you can re-add them later.'
                                            const ok = await confirm({
                                              title: 'Delete from tracking?',
                                              description: label,
                                              confirmLabel: 'Delete',
                                              destructive: false,
                                            })
                                            if (!ok) return
                                            setSelectedMods(new Set(ids))
                                            handleBulkRemove(ids)
                                          }}
                                        >
                                          <Trash2 className="w-4 h-4 me-1.5" />
                                          {someSelected
                                            ? 'Delete selected (' +
                                              String(
                                                selectedDeactivated.length,
                                              ) +
                                              ')'
                                            : 'Delete all (' +
                                              String(deactivatedIds.length) +
                                              ')'}
                                        </Button>
                                      </DisabledReason>
                                    </div>
                                  </details>
                                  {missingNameCount > 0 && (
                                    <div className="flex items-start gap-2 rounded border border-border/40 bg-card/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                                      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                      <div className="flex-1 flex items-center gap-2 flex-wrap">
                                        <span className="flex-1 min-w-0">
                                          {Number(missingNameCount) === 1 ? (
                                            <>
                                              {missingNameCount}
                                              {
                                                ' mod shows a generic name. Click '
                                              }
                                              <strong>{'Refresh names'}</strong>
                                              {
                                                ' to look it up (checks disk first, then the Steam Workshop API).'
                                              }
                                            </>
                                          ) : (
                                            <>
                                              {missingNameCount}
                                              {
                                                ' mods show a generic name. Click '
                                              }
                                              <strong>{'Refresh names'}</strong>
                                              {
                                                ' to look them up (checks disk first, then the Steam Workshop API).'
                                              }
                                            </>
                                          )}
                                        </span>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="h-6 px-2 text-[11px]"
                                          disabled={loading || !canManageMods}
                                          onClick={() => {
                                            const targets =
                                              groupedMods.deactivated
                                                .filter(
                                                  (m) =>
                                                    !m.name ||
                                                    /^Workshop Mod /i.test(
                                                      m.name,
                                                    ),
                                                )
                                                .map((m) => m.workshop_id)
                                            handleRefreshNames(targets)
                                          }}
                                        >
                                          <RefreshCw
                                            className={`w-3 h-3 me-1 ${loading ? 'animate-spin' : ''}`}
                                          />
                                          {'Refresh names'}
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )
                            })()}

                            <div className="divide-y divide-border/30">
                              {groupedMods.deactivated.map((mod) => {
                                const isSelected = selectedMods.has(
                                  mod.workshop_id,
                                )
                                return (
                                  <div
                                    key={mod.id}
                                    className={`group/modrow flex items-center gap-3 px-3 py-2.5 border-s-2 border-muted-foreground/20 hover:bg-accent/40 transition-colors ${isSelected ? 'bg-accent/30' : ''}`}
                                  >
                                    <div className="shrink-0">
                                      <Checkbox
                                        checked={isSelected}
                                        onCheckedChange={() =>
                                          toggleModSelect(mod.workshop_id)
                                        }
                                        aria-label={
                                          'Select ' +
                                          String(mod.name || mod.workshop_id)
                                        }
                                      />
                                    </div>
                                    <a
                                      href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="shrink-0 relative grid place-items-center w-16 h-16 rounded-md border border-border/50 bg-muted/30 text-muted-foreground overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                                      aria-label={
                                        'Open ' +
                                        String(
                                          mod.name ||
                                            'Workshop Mod ' +
                                              String(mod.workshop_id),
                                        ) +
                                        ' on Steam Workshop'
                                      }
                                      title={'Open Steam Workshop page'}
                                    >
                                      <Package
                                        className="w-7 h-7"
                                        aria-hidden="true"
                                      />
                                      <img
                                        src={
                                          demoMode
                                            ? `${import.meta.env.BASE_URL}spiffo.png`
                                            : `/api/mods/thumbnail/${mod.workshop_id}`
                                        }
                                        alt=""
                                        loading="lazy"
                                        decoding="async"
                                        className="absolute inset-0 w-full h-full object-cover rounded-md opacity-80"
                                        onError={(e) => {
                                          ;(
                                            e.currentTarget as HTMLImageElement
                                          ).style.display = 'none'
                                        }}
                                      />
                                    </a>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-1.5 min-w-0">
                                        <span className="truncate text-sm font-medium text-foreground/90">
                                          {mod.name ||
                                            'Workshop Mod ' +
                                              String(mod.workshop_id)}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-1.5 flex-wrap mt-0.5 text-[11px] text-muted-foreground">
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            copyText(mod.workshop_id)
                                              .then(() => {
                                                toast({
                                                  title: 'Copied',
                                                  description: `Workshop ID ${mod.workshop_id}`,
                                                })
                                              })
                                              .catch(() => {
                                                /* no-op */
                                              })
                                          }}
                                          className="inline-flex items-center gap-1 rounded border border-border/40 bg-muted/40 px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors"
                                          aria-label={
                                            'Copy workshop ID ' +
                                            String(mod.workshop_id)
                                          }
                                        >
                                          <span className="text-[9px] font-semibold uppercase tracking-wider opacity-70">
                                            WS
                                          </span>
                                          <span>{mod.workshop_id}</span>
                                        </button>
                                        {mod.last_checked && (
                                          <span>
                                            {'Checked ' +
                                              String(
                                                new Date(
                                                  mod.last_checked,
                                                ).toLocaleDateString('en'),
                                              )}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    <div className="shrink-0 flex items-center gap-0.5">
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <a
                                            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex"
                                          >
                                            <Button
                                              variant="ghost"
                                              size="iconDense"
                                              className="h-8 w-8 text-muted-foreground hover:text-primary"
                                              aria-label={'Open workshop page'}
                                            >
                                              <ExternalLink className="w-4 h-4" />
                                            </Button>
                                          </a>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {'Open Workshop Page'}
                                        </TooltipContent>
                                      </Tooltip>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="iconDense"
                                            className="h-8 w-8 text-muted-foreground hover:text-primary"
                                            onClick={() =>
                                              handleEnableMod(mod.workshop_id)
                                            }
                                            disabled={loading || !canManageMods}
                                            aria-label={
                                              'Re-enable ' +
                                              String(
                                                mod.name || mod.workshop_id,
                                              )
                                            }
                                          >
                                            <PlusCircle className="w-4 h-4" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {
                                            'Re-enable (add back to WorkshopItems=)'
                                          }
                                        </TooltipContent>
                                      </Tooltip>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="iconDense"
                                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                            onClick={() =>
                                              setConfirmRemoveMod(
                                                mod.workshop_id,
                                              )
                                            }
                                            disabled={loading || !canManageMods}
                                            aria-label={
                                              'Delete ' +
                                              String(
                                                mod.name || mod.workshop_id,
                                              ) +
                                              ' from tracking'
                                            }
                                          >
                                            <Trash2 className="w-4 h-4" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {'Delete from tracking'}
                                        </TooltipContent>
                                      </Tooltip>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <AlertDialog
        open={!!confirmRemoveMod}
        onOpenChange={(open) => {
          if (!open) setConfirmRemoveMod(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {'Remove this mod from the server?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {
                'This removes the mod from the server INI config so it stops loading. The Workshop files stay on disk (so re-adding later is instant).'
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmRemoveMod) handleRemoveMod(confirmRemoveMod)
                setConfirmRemoveMod(null)
              }}
              disabled={!canManageMods}
            >
              {'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmBulkRemove} onOpenChange={setConfirmBulkRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectedMods.size === 1
                ? 'Remove ' +
                  String(selectedMods.size) +
                  ' mod from the server?'
                : 'Remove ' +
                  String(selectedMods.size) +
                  ' mods from the server?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {
                'This removes the selected mods from the server INI config so they stop loading. Workshop files stay on disk (so re-adding later is instant).'
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                handleBulkRemove()
                setConfirmBulkRemove(false)
              }}
              disabled={!canManageMods}
            >
              {selectedMods.size === 1
                ? 'Remove ' + String(selectedMods.size) + ' mod'
                : 'Remove ' + String(selectedMods.size) + ' mods'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
