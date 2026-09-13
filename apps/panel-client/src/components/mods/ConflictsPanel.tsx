import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
  type MutableRefObject,
} from 'react'
import {
  RefreshCw,
  Plus,
  Trash2,
  ExternalLink,
  AlertTriangle,
  CheckCircle,
  Search,
  ChevronRight,
  Check,
  Info,
  Layers,
  Loader2,
  Shield,
  ShieldAlert,
  FileWarning,
  Wrench,
  Network,
  GitBranch,
  PlusCircle,
  ArrowRight,
} from 'lucide-react'
import type { ConflictScanResult, ScanStreamConflictFound } from '@/types'
import { modsApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { FileDiffViewer } from '@/components/FileDiffViewer'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DisabledReason } from '@/components/DisabledReason'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  CONFLICT_FILE_LIMIT,
  useLocalStorageState,
  type DepSearchState,
} from '@/lib/modsShared'

export interface ConflictsPanelProps {
  conflicts: ConflictScanResult | null
  conflictsLoading: boolean
  conflictsError: string | null
  conflictsStale: boolean
  lastScanTime: Date | null
  scanConflicts: () => void
  scanProgress: number
  scanCurrentMod: string | null
  scanModsScanned: number
  scanTotalMods: number
  streamConflicts: ScanStreamConflictFound[]
  focusDependencies?: boolean

  fetchData: () => void | Promise<void>
  busyRef: MutableRefObject<boolean>
  savingModOrder: boolean
  promoteModOverOpponent: (
    winnerModId: string,
    winnerName: string,
    loserModId: string,
    loserName: string,
  ) => Promise<void>
  toast: (opts: any) => void

  depSearchOpen: Set<string>
  setDepSearchOpen: Dispatch<SetStateAction<Set<string>>>
  depSearchData: Record<string, DepSearchState>
  setDepSearchData: Dispatch<SetStateAction<Record<string, DepSearchState>>>
  depAdding: string[]
  setDepAdding: Dispatch<SetStateAction<string[]>>
  depAddResults: Record<string, 'added' | 'error'>
  setDepAddResults: Dispatch<SetStateAction<Record<string, 'added' | 'error'>>>
}

export function ConflictsPanel({
  conflicts,
  conflictsLoading,
  conflictsError,
  conflictsStale,
  lastScanTime,
  scanConflicts,
  scanProgress,
  scanCurrentMod,
  scanModsScanned,
  scanTotalMods,
  streamConflicts,
  focusDependencies,
  fetchData,
  busyRef,
  savingModOrder,
  promoteModOverOpponent,
  toast,
  depSearchOpen,
  setDepSearchOpen,
  depSearchData,
  setDepSearchData,
  depAdding,
  setDepAdding,
  depAddResults,
  setDepAddResults,
}: ConflictsPanelProps) {
  const [openPairs, setOpenPairs] = useState<string[]>([])
  const [conflictSubTab, setConflictSubTab] = useLocalStorageState<
    'network' | 'dependencies'
  >('zcp:mods:conflicts:subTab', 'network')
  const [pairSeverityFilter, setPairSeverityFilter] = useLocalStorageState<
    'all' | 'real' | 'high' | 'medium' | 'low'
  >('zcp:mods:conflicts:severity', 'real')
  const [groupByWinner, setGroupByWinner] = useLocalStorageState<boolean>(
    'zcp:mods:conflicts:groupByWinner',
    true,
  )
  const [pairSearchQuery, setPairSearchQuery] = useLocalStorageState<string>(
    'zcp:mods:conflicts:search',
    '',
  )
  const [showAllTopMods, setShowAllTopMods] = useState<boolean>(false)
  const [graphFilterMod, setGraphFilterMod] = useState<string | null>(null)
  const [expandedFilePairs, setExpandedFilePairs] = useState<Set<string>>(
    new Set(),
  )
  const [modDetailsId, setModDetailsId] = useState<string | null>(null)
  const [fixingAllDeps, setFixingAllDeps] = useState(false)

  useEffect(() => {
    if (!conflictsLoading) return
    setGraphFilterMod(null)
    setOpenPairs([])
  }, [conflictsLoading])

  useEffect(() => {
    if (focusDependencies) setConflictSubTab('dependencies')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDependencies])

  const severityCounts = useMemo(() => {
    if (!conflicts?.pairs?.length) return { all: 0, high: 0, medium: 0, low: 0 }
    const allPairs = graphFilterMod
      ? conflicts.pairs.filter(
          (p) =>
            p.modA.modId === graphFilterMod || p.modB.modId === graphFilterMod,
        )
      : conflicts.pairs
    return {
      all: allPairs.length,
      real: allPairs.filter((p) => p.highCount > 0 || p.mediumCount > 0).length,
      high: allPairs.filter((p) => p.highCount > 0).length,
      medium: allPairs.filter((p) => p.mediumCount > 0).length,
      low: allPairs.filter((p) => p.lowCount > 0).length,
    }
  }, [conflicts?.pairs, graphFilterMod])

  const depRows = useMemo(() => {
    const missingDeps = conflicts?.missingDeps || []
    const steamDeps = conflicts?.steamDeps || []
    type DepRow = {
      key: string
      requiredBy: string
      requiredByWsId: string
      depName: string
      depModId: string | null
      depWorkshopId: string | null
      source: 'local' | 'steam'
    }
    const rows: DepRow[] = []
    for (const sd of steamDeps) {
      rows.push({
        key: `steam-${sd.parentWorkshopId}-${sd.childWorkshopId}`,
        requiredBy: sd.parentName,
        requiredByWsId: sd.parentWorkshopId,
        depName: sd.childName,
        depModId: null,
        depWorkshopId: sd.childWorkshopId,
        source: 'steam',
      })
    }
    for (const dep of missingDeps) {
      const alreadyCovered = steamDeps.some(
        (sd) =>
          sd.parentWorkshopId === dep.workshopId &&
          dep.resolvedWorkshopId &&
          sd.childWorkshopId === dep.resolvedWorkshopId,
      )
      if (alreadyCovered) continue
      rows.push({
        key: `local-${dep.workshopId}-${dep.missingDep}`,
        requiredBy: dep.modName,
        requiredByWsId: dep.workshopId,
        depName: dep.resolvedModName || dep.missingDep,
        depModId: dep.missingDep,
        depWorkshopId: dep.resolvedWorkshopId || null,
        source: 'local',
      })
    }
    return rows
  }, [conflicts?.missingDeps, conflicts?.steamDeps])

  const dedupedDepCount = useMemo(() => {
    const missingDeps = conflicts?.missingDeps || []
    const steamDeps = conflicts?.steamDeps || []
    let count = steamDeps.length
    for (const dep of missingDeps) {
      const alreadyCovered = steamDeps.some(
        (sd) =>
          sd.parentWorkshopId === dep.workshopId &&
          dep.resolvedWorkshopId &&
          sd.childWorkshopId === dep.resolvedWorkshopId,
      )
      if (!alreadyCovered) count++
    }
    return count
  }, [conflicts?.missingDeps, conflicts?.steamDeps])

  const loadOrderMap = useMemo(() => {
    const entries: [string, number][] = (conflicts?.modLoadOrder ?? []).map(
      (id, i) => [id, i + 1] as [string, number],
    )
    return new Map(entries)
  }, [conflicts?.modLoadOrder])

  const filteredPairs = useMemo(() => {
    if (!conflicts?.pairs?.length) return []
    let pairs = graphFilterMod
      ? conflicts.pairs.filter(
          (p) =>
            p.modA.modId === graphFilterMod || p.modB.modId === graphFilterMod,
        )
      : conflicts.pairs
    if (pairSeverityFilter !== 'all') {
      pairs = pairs.filter((p) => {
        if (pairSeverityFilter === 'real')
          return p.highCount > 0 || p.mediumCount > 0
        if (pairSeverityFilter === 'high') return p.highCount > 0
        if (pairSeverityFilter === 'medium') return p.mediumCount > 0
        if (pairSeverityFilter === 'low') return p.lowCount > 0
        return true
      })
    }
    const q = pairSearchQuery.trim().toLowerCase()
    if (q) {
      pairs = pairs.filter(
        (p) =>
          p.modA.modName.toLowerCase().includes(q) ||
          p.modB.modName.toLowerCase().includes(q) ||
          p.modA.modId.toLowerCase().includes(q) ||
          p.modB.modId.toLowerCase().includes(q),
      )
    }
    return pairs
  }, [conflicts?.pairs, graphFilterMod, pairSeverityFilter, pairSearchQuery])

  const topConflictingMods = useMemo(() => {
    if (!conflicts?.pairs?.length) return []
    const modStats = new Map<
      string,
      {
        modId: string
        modName: string
        pairs: number
        high: number
        medium: number
        low: number
        files: number
      }
    >()
    for (const pair of conflicts.pairs) {
      for (const mod of [pair.modA, pair.modB]) {
        if (!modStats.has(mod.modId)) {
          modStats.set(mod.modId, {
            modId: mod.modId,
            modName: mod.modName,
            pairs: 0,
            high: 0,
            medium: 0,
            low: 0,
            files: 0,
          })
        }
        const s = modStats.get(mod.modId)!
        s.pairs++
        s.high += pair.highCount
        s.medium += pair.mediumCount
        s.low += pair.lowCount
        s.files += pair.files.length
      }
    }
    return Array.from(modStats.values())
      .sort(
        (a, b) => b.high - a.high || b.medium - a.medium || b.pairs - a.pairs,
      )
      .slice(0, 15)
  }, [conflicts?.pairs])

  const groupedPairs = useMemo(() => {
    if (!filteredPairs.length)
      return [] as Array<{
        key: string
        name: string
        modId: string | null
        pairs: typeof filteredPairs
      }>
    const groups = new Map<
      string,
      {
        key: string
        name: string
        modId: string | null
        pairs: typeof filteredPairs
      }
    >()
    for (const pair of filteredPairs) {
      const aw = pair.aWins ?? 0,
        bw = pair.bWins ?? 0,
        tp = pair.thirdPartyWins ?? 0,
        uk = pair.unknownWins ?? 0
      const aWinsAll = aw > 0 && bw === 0 && tp === 0 && uk === 0
      const bWinsAll = bw > 0 && aw === 0 && tp === 0 && uk === 0
      const tpWinsAll = tp > 0 && aw === 0 && bw === 0
      let key: string, name: string, modId: string | null
      if (aWinsAll) {
        key = pair.modA.modId
        name = pair.modA.modName
        modId = pair.modA.modId
      } else if (bWinsAll) {
        key = pair.modB.modId
        name = pair.modB.modName
        modId = pair.modB.modId
      } else if (tpWinsAll) {
        const tpMod = pair.files.find(
          (f) =>
            f.winner &&
            f.winner.modId !== pair.modA.modId &&
            f.winner.modId !== pair.modB.modId,
        )?.winner
        key = tpMod?.modId ?? '__third_party__'
        name = tpMod?.modName ?? 'Other mod'
        modId = tpMod?.modId ?? null
      } else if (aw === 0 && bw === 0 && tp === 0 && uk === 0) {
        const posA = loadOrderMap.get(pair.modA.modId)
        const posB = loadOrderMap.get(pair.modB.modId)
        if (posA != null && posB != null && posA !== posB) {
          if (posA > posB) {
            key = pair.modA.modId
            name = pair.modA.modName
            modId = pair.modA.modId
          } else {
            key = pair.modB.modId
            name = pair.modB.modName
            modId = pair.modB.modId
          }
        } else {
          key = '__split__'
          name = 'Mixed / unresolved'
          modId = null
        }
      } else {
        key = '__split__'
        name = 'Mixed / unresolved'
        modId = null
      }
      if (!groups.has(key)) groups.set(key, { key, name, modId, pairs: [] })
      groups.get(key)!.pairs.push(pair)
    }
    return [...groups.values()].sort((a, b) => {
      const aSpecial = a.key.startsWith('__'),
        bSpecial = b.key.startsWith('__')
      if (aSpecial !== bSpecial) return aSpecial ? 1 : -1
      return b.pairs.length - a.pairs.length
    })
  }, [filteredPairs, loadOrderMap])

  useEffect(() => {
    if (!conflicts) return
    if (
      pairSeverityFilter === 'real' &&
      severityCounts.real === 0 &&
      severityCounts.low > 0
    ) {
      setPairSeverityFilter('low')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Shield className="w-4 h-4" aria-hidden="true" />
                {'Mod Conflict Scanner'}
              </CardTitle>
              <CardDescription className="mt-1">
                {
                  'Checks if multiple mods modify the same files — when they do, only the last mod in your load order takes effect'
                }
              </CardDescription>
            </div>
            {conflicts && !conflictsLoading && (
              <div className="flex items-center gap-2 shrink-0">
                {lastScanTime && (
                  <span className="text-[11px] tabular-nums text-muted-foreground/70 hidden sm:inline">
                    {'Last scan ' +
                      String(new Date(lastScanTime).toLocaleTimeString('en'))}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={scanConflicts}
                  disabled={conflictsLoading}
                >
                  <RefreshCw className="w-3.5 h-3.5 me-1.5" />
                  {'Rescan'}
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {conflictsLoading && !conflicts ? (
            <div className="py-6">
              <div className="max-w-md mx-auto space-y-4">
                <div className="space-y-2">
                  <div
                    className="flex items-center justify-between text-xs text-muted-foreground"
                    aria-live="polite"
                  >
                    <span>{scanCurrentMod || 'Preparing to scan mods...'}</span>
                    {scanProgress > 0 && (
                      <span className="tabular-nums">{scanProgress}%</span>
                    )}
                  </div>
                  <div
                    className={`h-1.5 rounded-full bg-border/50 overflow-hidden ${scanProgress === 0 ? 'scan-indeterminate' : ''}`}
                    role="progressbar"
                    aria-valuenow={scanProgress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={'Conflict scan progress'}
                  >
                    {scanProgress > 0 && (
                      <div
                        className={`h-full rounded-full bg-primary transition-all duration-500 ease-out ${scanProgress > 0 && scanProgress < 100 ? 'scan-progress-glow' : ''} ${scanProgress >= 100 ? 'scan-complete-flash' : ''}`}
                        style={{ width: `${scanProgress}%` }}
                      />
                    )}
                  </div>
                  {scanTotalMods > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {String(scanModsScanned) +
                        ' of ' +
                        String(scanTotalMods) +
                        ' mods scanned'}
                    </p>
                  )}
                </div>

                {streamConflicts.length > 0 && (
                  <div
                    className="rounded-lg border border-border/30 bg-muted/10 overflow-hidden"
                    aria-live="polite"
                  >
                    <div className="px-3 py-1.5 text-[11px] font-medium text-warning/80 border-b border-border/30 bg-warning/5">
                      {(() => {
                        const n =
                          streamConflicts[streamConflicts.length - 1]
                            ?.conflictsSoFar ?? streamConflicts.length
                        return Number(n) === 1
                          ? String(n) + ' conflict found so far'
                          : String(n) + ' conflicts found so far'
                      })()}
                    </div>
                    <div className="max-h-32 overflow-y-auto">
                      {streamConflicts.slice(-8).map((c) => (
                        <div
                          key={`${c.file}:${c.conflictsSoFar}`}
                          className={`flex items-center gap-2 px-3 py-1 text-[11px] conflict-stream-enter ${
                            c.severity === 'high'
                              ? 'bg-destructive/5'
                              : c.severity === 'medium'
                                ? 'bg-warning/5'
                                : ''
                          }`}
                        >
                          <div
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                              c.severity === 'high'
                                ? 'bg-destructive severity-pulse'
                                : c.severity === 'medium'
                                  ? 'bg-warning'
                                  : 'bg-primary/50'
                            }`}
                            aria-hidden="true"
                          />
                          <span className="sr-only">
                            {String(c.severity) + ' severity:'}
                          </span>
                          <span className="font-mono text-foreground/70 truncate flex-1">
                            {c.file}
                          </span>
                          <span className="text-muted-foreground/70 shrink-0">
                            {Number(c.mods.length) === 1
                              ? 'in ' + String(c.mods.length) + ' mod'
                              : 'in ' + String(c.mods.length) + ' mods'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : conflictsError && !conflicts ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <div className="text-center max-w-xs space-y-3">
                <ShieldAlert
                  className="w-10 h-10 mx-auto text-destructive/60"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-medium text-foreground text-sm">
                    {'Scan failed'}
                  </p>
                  <p
                    className="text-xs mt-1.5 text-muted-foreground break-words"
                    dir="auto"
                  >
                    {conflictsError}
                  </p>
                  <p className="text-[11px] mt-2 text-muted-foreground leading-relaxed">
                    {
                      'Check that the backend is running, your workshop path is set in Settings, and mods are downloaded.'
                    }
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={scanConflicts}
                  disabled={conflictsLoading}
                >
                  <RefreshCw className="w-3.5 h-3.5 me-1.5" /> {'Retry'}
                </Button>
              </div>
            </div>
          ) : !conflicts ? (
            <div className="py-6">
              <div className="mx-auto max-w-2xl">
                <div className="flex flex-col items-center text-center mb-6">
                  <div className="relative mb-4" aria-hidden="true">
                    <div className="absolute inset-0 rounded-2xl bg-primary/15 blur-xl" />
                    <div className="relative w-16 h-16 rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center">
                      <Shield className="w-8 h-8 text-primary" />
                    </div>
                  </div>
                  <h3 className="text-base font-semibold text-foreground">
                    {'Ready to scan your mods'}
                  </h3>
                  <p className="mt-1.5 text-sm text-muted-foreground max-w-md leading-relaxed">
                    {
                      "Cross-checks every active mod's files against the others to find what conflicts — and tells you which mod actually wins."
                    }
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">
                  <div className="rounded-lg border border-border/50 bg-muted/15 px-3 py-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <FileWarning
                        className="w-3.5 h-3.5 text-warning"
                        aria-hidden="true"
                      />
                      <span className="text-xs font-semibold text-foreground/90">
                        {'File overlaps'}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      {
                        'Lua scripts, items, textures, maps, sounds — anything two mods both ship.'
                      }
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/15 px-3 py-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Layers
                        className="w-3.5 h-3.5 text-primary"
                        aria-hidden="true"
                      />
                      <span className="text-xs font-semibold text-foreground/90">
                        {'Load-order winners'}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      {
                        'For each clash, identifies which mod actually takes effect at runtime.'
                      }
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/15 px-3 py-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <GitBranch
                        className="w-3.5 h-3.5 text-destructive"
                        aria-hidden="true"
                      />
                      <span className="text-xs font-semibold text-foreground/90">
                        {'Missing dependencies'}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      {
                        "Flags mods that require other mods you don't have installed."
                      }
                    </p>
                  </div>
                </div>

                <div className="flex flex-col items-center gap-2">
                  <Button
                    onClick={scanConflicts}
                    disabled={conflictsLoading}
                    className="min-w-[200px]"
                  >
                    <Shield className="w-4 h-4 me-2" aria-hidden="true" />
                    {'Scan mods for conflicts'}
                  </Button>
                  <p className="text-[11px] text-muted-foreground/70 flex items-center gap-1.5">
                    <Info className="w-3 h-3" aria-hidden="true" />
                    {
                      'Read-only — the panel never modifies your mod files. Typically takes a few seconds.'
                    }
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div
              className={`space-y-3 stagger-in relative ${conflictsLoading ? 'pointer-events-none' : ''}`}
            >
              {conflictsLoading && (
                <div
                  className="absolute inset-0 bg-background/60 backdrop-blur-[1px] z-10 flex items-center justify-center rounded-lg transition-opacity duration-200 animate-in fade-in"
                  role="status"
                  aria-busy="true"
                >
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw
                      className="w-4 h-4 animate-spin"
                      aria-hidden="true"
                    />
                    {'Scanning mods...'}
                  </div>
                </div>
              )}

              {conflictsError &&
                (() => {
                  const recovered = !!conflicts
                  const isCacheFallback = /cached results/i.test(conflictsError)
                  const tone =
                    recovered || isCacheFallback
                      ? 'border-warning/30 bg-warning/5 text-warning'
                      : 'border-destructive/30 bg-destructive/5 text-destructive'
                  return (
                    <div
                      className={`rounded-lg border p-3 flex items-center gap-2 text-xs ${tone}`}
                      role={isCacheFallback ? 'status' : 'alert'}
                    >
                      <AlertTriangle
                        className="w-3.5 h-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="flex-1 min-w-0 break-words" dir="auto">
                        {conflictsError}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 px-3 text-xs shrink-0"
                        onClick={scanConflicts}
                        disabled={conflictsLoading}
                      >
                        {recovered ? 'Rescan' : 'Retry'}
                      </Button>
                    </div>
                  )
                })()}

              {conflictsStale && !conflictsLoading && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 flex items-center gap-2 text-xs">
                  <AlertTriangle
                    className="w-3.5 h-3.5 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <span className="flex-1 text-muted-foreground">
                    {
                      'Your mod list changed since this scan — results may be outdated.'
                    }
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 px-3 text-xs shrink-0"
                    onClick={scanConflicts}
                    disabled={conflictsLoading}
                  >
                    {'Rescan'}
                  </Button>
                </div>
              )}

              {(conflicts.idCollisions?.filter((c) => c.active).length ?? 0) >
                0 && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                  <div className="flex items-start gap-2 text-xs">
                    <ShieldAlert
                      className="w-4 h-4 shrink-0 text-destructive mt-0.5"
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-destructive">
                        {Number(
                          conflicts.idCollisions!.filter((c) => c.active)
                            .length,
                        ) === 1
                          ? 'Mod ID collision — ' +
                            String(
                              conflicts.idCollisions!.filter((c) => c.active)
                                .length,
                            ) +
                            ' mod declared by multiple Workshop items'
                          : 'Mod ID collision — ' +
                            String(
                              conflicts.idCollisions!.filter((c) => c.active)
                                .length,
                            ) +
                            ' mods declared by multiple Workshop items'}
                      </p>
                      <p className="text-muted-foreground mt-0.5 leading-relaxed">
                        {
                          'PZ will load only one of each. The others are silently ignored — common cause of "my mod isn\'t working" issues.'
                        }
                      </p>
                    </div>
                  </div>
                  <div className="space-y-1.5 ps-6">
                    {conflicts
                      .idCollisions!.filter((c) => c.active)
                      .map((coll) => (
                        <div
                          key={coll.modId}
                          className="text-[11px] flex items-baseline gap-2 flex-wrap"
                        >
                          <code className="font-mono px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-medium shrink-0">
                            {coll.modId}
                          </code>
                          <span className="text-muted-foreground">
                            {'declared by'}
                          </span>
                          {coll.sources.map((s, i) => (
                            <span
                              key={s.workshopId}
                              className="inline-flex items-center gap-1 text-foreground/80"
                            >
                              <a
                                href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${s.workshopId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline truncate max-w-[200px]"
                                title={
                                  String(s.modName) +
                                  ' (Workshop #' +
                                  String(s.workshopId) +
                                  ')'
                                }
                              >
                                {s.modName}
                              </a>
                              {i < coll.sources.length - 1 && (
                                <span className="text-muted-foreground/50">
                                  ·
                                </span>
                              )}
                            </span>
                          ))}
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {(() => {
                const f = pairSeverityFilter
                const headlineCount =
                  (f === 'all'
                    ? severityCounts.all
                    : f === 'real'
                      ? severityCounts.real
                      : f === 'high'
                        ? severityCounts.high
                        : f === 'medium'
                          ? severityCounts.medium
                          : severityCounts.low) ?? 0
                const headlineLabel =
                  f === 'all'
                    ? Number(headlineCount) === 1
                      ? 'overlapping mod pair'
                      : 'overlapping mod pairs'
                    : f === 'real'
                      ? Number(headlineCount) === 1
                        ? 'higher-impact conflict'
                        : 'higher-impact conflicts'
                      : f === 'high'
                        ? Number(headlineCount) === 1
                          ? 'critical conflict'
                          : 'critical conflicts'
                        : f === 'medium'
                          ? Number(headlineCount) === 1
                            ? 'medium conflict'
                            : 'medium conflicts'
                          : Number(headlineCount) === 1
                            ? 'low-severity overlap'
                            : 'low-severity overlaps'
                const tone =
                  headlineCount > 0 &&
                  (f === 'real' || f === 'high' || f === 'medium')
                    ? 'warning'
                    : headlineCount > 0
                      ? 'muted'
                      : 'success'
                const isWarn = tone === 'warning'
                const isSuccess = tone === 'success'
                return conflicts.modsScanned > 0 ? (
                  <div
                    className={`relative rounded-lg border overflow-hidden ${
                      isWarn
                        ? 'border-warning/30 bg-warning/[0.04]'
                        : isSuccess
                          ? 'border-success/30 bg-success/[0.04]'
                          : 'border-border/40 bg-muted/[0.04]'
                    }`}
                    role="status"
                    aria-live="polite"
                  >
                    <div
                      className={`absolute inset-y-0 left-0 w-1 ${isWarn ? 'bg-warning/60' : isSuccess ? 'bg-success/60' : 'bg-muted-foreground/40'}`}
                      aria-hidden="true"
                    />

                    <div className="flex items-stretch">
                      <div className="flex items-center gap-3.5 px-4 py-3 flex-1 min-w-0">
                        {isWarn ? (
                          <FileWarning
                            className="w-5 h-5 text-warning shrink-0"
                            aria-hidden="true"
                          />
                        ) : isSuccess ? (
                          <CheckCircle
                            className="w-5 h-5 text-success shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <Info
                            className="w-5 h-5 text-muted-foreground shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <div className="flex items-baseline gap-2 min-w-0">
                          <span
                            className={`text-2xl font-semibold leading-none tabular-nums ${
                              isWarn
                                ? 'text-warning'
                                : isSuccess
                                  ? 'text-success'
                                  : 'text-foreground/80'
                            }`}
                          >
                            {headlineCount}
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground/90 leading-tight">
                              {headlineCount > 0
                                ? headlineLabel
                                : 'No conflicts in this view'}
                            </p>
                            <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                              {f === 'all' || f === 'low'
                                ? [
                                    Number(severityCounts.real) === 1
                                      ? String(severityCounts.real) +
                                        ' higher-impact conflict'
                                      : String(severityCounts.real) +
                                        ' higher-impact conflicts',
                                    Number(severityCounts.low) === 1
                                      ? String(severityCounts.low) +
                                        ' low-severity'
                                      : String(severityCounts.low) +
                                        ' low-severity',
                                    Number(conflicts.modsScanned) === 1
                                      ? String(conflicts.modsScanned) +
                                        ' mod scanned'
                                      : String(conflicts.modsScanned) +
                                        ' mods scanned',
                                  ].join(' · ')
                                : [
                                    Number(severityCounts.all) === 1
                                      ? String(severityCounts.all) +
                                        ' total overlapping pair'
                                      : String(severityCounts.all) +
                                        ' total overlapping pairs',
                                    Number(conflicts.modsScanned) === 1
                                      ? String(conflicts.modsScanned) +
                                        ' mod scanned'
                                      : String(conflicts.modsScanned) +
                                        ' mods scanned',
                                  ].join(' · ')}
                            </p>
                          </div>
                        </div>
                        {dedupedDepCount > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() =>
                                  setConflictSubTab('dependencies')
                                }
                                className="ms-auto inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/15 transition-colors shrink-0"
                              >
                                <GitBranch
                                  className="w-3 h-3"
                                  aria-hidden="true"
                                />
                                {Number(dedupedDepCount) === 1
                                  ? String(dedupedDepCount) + ' missing dep'
                                  : String(dedupedDepCount) + ' missing deps'}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent
                              side="bottom"
                              className="text-xs max-w-xs"
                            >
                              <p>
                                {
                                  'Mods that require other mods not in your server config.'
                                }
                              </p>
                              <p className="text-muted-foreground mt-0.5">
                                {'Click to view details and fix them.'}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>

                      <div className="flex items-center gap-4 border-s border-border/30 px-4 py-3 text-[11px] bg-background/30">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="text-center cursor-help">
                              <div className="tabular-nums font-semibold text-foreground/80 leading-none">
                                {conflicts.modsScanned}
                              </div>
                              <div className="text-muted-foreground mt-1 leading-none">
                                {'scanned'}
                              </div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent
                            side="bottom"
                            className="text-xs max-w-xs space-y-0.5"
                          >
                            <p>
                              {Number(conflicts.modsScanned) === 1
                                ? String(conflicts.modsScanned) +
                                  ' active mod compared file-by-file.'
                                : String(conflicts.modsScanned) +
                                  ' active mods compared file-by-file.'}
                            </p>
                            {(conflicts.modsSkippedInactive ?? 0) > 0 && (
                              <p className="text-muted-foreground">
                                {String(conflicts.modsSkippedInactive) +
                                  ' inactive (in WorkshopItems but not Mods=)'}
                              </p>
                            )}
                            {(conflicts.modsNotFound ?? 0) > 0 && (
                              <p className="text-muted-foreground">
                                {String(conflicts.modsNotFound) +
                                  ' not downloaded on disk'}
                              </p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                        {(conflicts.modsNotFound ?? 0) > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="text-center cursor-help">
                                <div className="tabular-nums font-semibold text-muted-foreground leading-none">
                                  {conflicts.modsNotFound}
                                </div>
                                <div className="text-muted-foreground mt-1 leading-none">
                                  {'not on disk'}
                                </div>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="bottom"
                              className="text-xs max-w-xs"
                            >
                              {
                                "Tracked mods not downloaded locally. They can't be analyzed for conflicts — download them via Steam Workshop or remove from WorkshopItems."
                              }
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {(conflicts.identicalSkipped ?? 0) > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="text-center cursor-help opacity-70">
                                <div className="tabular-nums font-medium text-success/70 leading-none text-[11px]">
                                  {conflicts.identicalSkipped}
                                </div>
                                <div className="text-muted-foreground/70 mt-1 leading-none text-[10px]">
                                  {'identical'}
                                </div>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="bottom"
                              className="text-xs max-w-xs"
                            >
                              {
                                'Files shared by multiple mods with byte-identical content. The result is the same regardless of load order.'
                              }
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {(conflicts.additiveSkipped ?? 0) +
                          (conflicts.pzAdditiveSkipped ?? 0) >
                          0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="text-center cursor-help opacity-70">
                                <div className="tabular-nums font-medium text-success/70 leading-none text-[11px]">
                                  {(conflicts.additiveSkipped ?? 0) +
                                    (conflicts.pzAdditiveSkipped ?? 0)}
                                </div>
                                <div className="text-muted-foreground/70 mt-1 leading-none text-[10px]">
                                  {'additive'}
                                </div>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="bottom"
                              className="text-xs space-y-0.5"
                            >
                              <p className="font-medium mb-1">
                                {
                                  'Files PZ merges automatically. These are not conflicts:'
                                }
                              </p>
                              {(conflicts.pzAdditiveBreakdown?.sandbox ?? 0) >
                                0 && (
                                <p>
                                  {String(
                                    conflicts.pzAdditiveBreakdown!.sandbox,
                                  ) + ' sandbox-options.txt'}
                                </p>
                              )}
                              {(conflicts.pzAdditiveBreakdown?.translate ?? 0) +
                                (conflicts.additiveSkipped ?? 0) >
                                0 && (
                                <p>
                                  {Number(
                                    (conflicts.pzAdditiveBreakdown?.translate ??
                                      0) + (conflicts.additiveSkipped ?? 0),
                                  ) === 1
                                    ? String(
                                        (conflicts.pzAdditiveBreakdown
                                          ?.translate ?? 0) +
                                          (conflicts.additiveSkipped ?? 0),
                                      ) + ' translation file'
                                    : String(
                                        (conflicts.pzAdditiveBreakdown
                                          ?.translate ?? 0) +
                                          (conflicts.additiveSkipped ?? 0),
                                      ) + ' translation files'}
                                </p>
                              )}
                              {(conflicts.pzAdditiveBreakdown?.scripts ?? 0) >
                                0 && (
                                <p>
                                  {Number(
                                    conflicts.pzAdditiveBreakdown!.scripts,
                                  ) === 1
                                    ? String(
                                        conflicts.pzAdditiveBreakdown!.scripts,
                                      ) + ' script file (different definitions)'
                                    : String(
                                        conflicts.pzAdditiveBreakdown!.scripts,
                                      ) +
                                      ' script files (different definitions)'}
                                </p>
                              )}
                              {(conflicts.pzAdditiveBreakdown?.clothing ?? 0) >
                                0 && (
                                <p>
                                  {Number(
                                    conflicts.pzAdditiveBreakdown!.clothing,
                                  ) === 1
                                    ? String(
                                        conflicts.pzAdditiveBreakdown!.clothing,
                                      ) + ' clothing XML (different items)'
                                    : String(
                                        conflicts.pzAdditiveBreakdown!.clothing,
                                      ) + ' clothing XMLs (different items)'}
                                </p>
                              )}
                              {(conflicts.pzAdditiveBreakdown?.fileguidtable ??
                                0) > 0 && (
                                <p>
                                  {String(
                                    conflicts.pzAdditiveBreakdown!
                                      .fileguidtable,
                                  ) + ' mod editor metadata'}
                                </p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {(conflicts.warnings?.length ?? 0) > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="text-center cursor-help">
                                <div className="tabular-nums font-semibold text-warning leading-none">
                                  {conflicts.warnings!.length}
                                </div>
                                <div className="text-warning/70 mt-1 leading-none">
                                  {Number(conflicts.warnings!.length) === 1
                                    ? 'warning'
                                    : 'warnings'}
                                </div>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="bottom"
                              className="max-w-xs text-xs space-y-0.5"
                            >
                              {conflicts.warnings!.slice(0, 5).map((w, i) => (
                                <p key={i} className="break-words">
                                  {w}
                                </p>
                              ))}
                              {conflicts.warnings!.length > 5 && (
                                <p className="text-muted-foreground">
                                  {'+' +
                                    String(conflicts.warnings!.length - 5) +
                                    ' more'}
                                </p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Info
                        className="w-3.5 h-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      {
                        'No mods are configured. Add mods in Server Config first.'
                      }
                    </p>
                  </div>
                )
              })()}

              {conflicts.modsScanned > 0 &&
                conflicts.totalConflicts === 0 &&
                dedupedDepCount === 0 && (
                  <div className="flex items-center justify-center py-8 text-muted-foreground scan-complete-flash">
                    <div className="text-center max-w-xs">
                      <CheckCircle
                        className="w-8 h-8 mx-auto text-success/70 mb-2"
                        aria-hidden="true"
                      />
                      <p className="font-medium text-foreground text-sm">
                        {'No conflicts found'}
                      </p>
                      <p className="text-xs mt-1 text-muted-foreground">
                        {Number(conflicts.modsScanned) === 1
                          ? String(conflicts.modsScanned) +
                            ' mod scanned — no files overlap between different mods.'
                          : String(conflicts.modsScanned) +
                            ' mods scanned — no files overlap between different mods.'}
                        {(conflicts.modsNotFound ?? 0) > 0 && (
                          <span className="block mt-0.5">
                            {Number(conflicts.modsNotFound) === 1
                              ? String(conflicts.modsNotFound) +
                                ' mod not downloaded on disk (skipped)'
                              : String(conflicts.modsNotFound) +
                                ' mods not downloaded on disk (skipped)'}
                          </span>
                        )}
                        {(conflicts.identicalSkipped ?? 0) > 0 && (
                          <span className="block mt-0.5">
                            {Number(conflicts.identicalSkipped) === 1
                              ? String(conflicts.identicalSkipped) +
                                ' identical file shared across mods (safe, not a conflict)'
                              : String(conflicts.identicalSkipped) +
                                ' identical files shared across mods (safe, not a conflict)'}
                          </span>
                        )}
                        {(conflicts.additiveSkipped ?? 0) +
                          (conflicts.pzAdditiveSkipped ?? 0) >
                          0 && (
                          <span className="block mt-0.5">
                            {Number(
                              (conflicts.additiveSkipped ?? 0) +
                                (conflicts.pzAdditiveSkipped ?? 0),
                            ) === 1
                              ? String(
                                  (conflicts.additiveSkipped ?? 0) +
                                    (conflicts.pzAdditiveSkipped ?? 0),
                                ) +
                                ' file PZ merges automatically (translations, sandbox options, clothing, scripts)'
                              : String(
                                  (conflicts.additiveSkipped ?? 0) +
                                    (conflicts.pzAdditiveSkipped ?? 0),
                                ) +
                                ' files PZ merges automatically (translations, sandbox options, clothing, scripts)'}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                )}

              {(conflicts.totalConflicts > 0 || dedupedDepCount > 0) && (
                <div>
                  <div className="flex items-center gap-1 border-b border-border/30 mb-3">
                    <button
                      onClick={() => setConflictSubTab('network')}
                      className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                        conflictSubTab === 'network'
                          ? 'border-accent text-accent-foreground'
                          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border/50'
                      }`}
                    >
                      <Network className="w-3.5 h-3.5" />
                      {'File Conflicts'}
                      {conflicts.totalPairs > 0 && (
                        <Badge
                          variant="secondary"
                          className="text-[11px] h-4 px-1 ms-0.5"
                        >
                          {conflicts.totalPairs}
                        </Badge>
                      )}
                    </button>
                    <button
                      onClick={() => setConflictSubTab('dependencies')}
                      className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                        conflictSubTab === 'dependencies'
                          ? 'border-accent text-accent-foreground'
                          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border/50'
                      }`}
                    >
                      <GitBranch className="w-3.5 h-3.5" />
                      {'Missing Dependencies'}
                      {dedupedDepCount > 0 && (
                        <Badge
                          variant="destructive"
                          className="text-[11px] h-4 px-1 ms-0.5"
                        >
                          {dedupedDepCount}
                        </Badge>
                      )}
                    </button>
                  </div>

                  {conflictSubTab === 'network' && (
                    <div className="space-y-3">
                      {(conflicts.pairs?.length ?? 0) > 0 &&
                        (() => {
                          const allPairKeys = filteredPairs.map(
                            (p) => `${p.modA.modId}--${p.modB.modId}`,
                          )
                          const allExpanded =
                            openPairs.length === allPairKeys.length &&
                            allPairKeys.length > 0
                          const sevFilteredTopMods = topConflictingMods
                            .map((m) => {
                              if (pairSeverityFilter === 'high')
                                return { ...m, medium: 0, low: 0 }
                              if (pairSeverityFilter === 'medium')
                                return { ...m, high: 0, low: 0 }
                              if (pairSeverityFilter === 'low')
                                return { ...m, high: 0, medium: 0 }
                              if (pairSeverityFilter === 'real')
                                return { ...m, low: 0 }
                              return m
                            })
                            .filter((m) => m.high + m.medium + m.low > 0)
                          const visibleTopMods = showAllTopMods
                            ? sevFilteredTopMods
                            : sevFilteredTopMods.slice(0, 6)
                          const hiddenTopCount =
                            sevFilteredTopMods.length - visibleTopMods.length
                          return (
                            <>
                              <div className="rounded-lg border border-border/35 bg-card/35 px-3 py-2.5 space-y-2">
                                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                                  <div className="flex flex-wrap items-center gap-1">
                                    {[
                                      {
                                        key: 'real' as const,
                                        label: 'Higher impact',
                                        count: severityCounts.real,
                                        dot: 'bg-warning',
                                        color: 'text-warning',
                                      },
                                      {
                                        key: 'high' as const,
                                        label: 'Critical',
                                        count: severityCounts.high,
                                        dot: 'bg-destructive',
                                        color: 'text-destructive',
                                      },
                                      {
                                        key: 'medium' as const,
                                        label: 'Medium',
                                        count: severityCounts.medium,
                                        dot: 'bg-warning',
                                        color: 'text-warning',
                                      },
                                      {
                                        key: 'low' as const,
                                        label: 'Low',
                                        count: severityCounts.low,
                                        dot: 'bg-primary/60',
                                        color: 'text-primary/70',
                                      },
                                      {
                                        key: 'all' as const,
                                        label: 'All',
                                        count: severityCounts.all,
                                        dot: null,
                                      },
                                    ].map((tab) => (
                                      <button
                                        key={tab.key}
                                        onClick={() =>
                                          setPairSeverityFilter(tab.key)
                                        }
                                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                          pairSeverityFilter === tab.key
                                            ? 'bg-accent text-accent-foreground'
                                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                                        }`}
                                        title={
                                          tab.key === 'real'
                                            ? 'Critical + Medium pairs most likely to change behavior'
                                            : tab.key === 'all'
                                              ? 'Every detected overlapping pair, including low-impact file overrides'
                                              : undefined
                                        }
                                      >
                                        {tab.dot && (
                                          <span
                                            className={`w-1.5 h-1.5 rounded-full ${tab.dot}`}
                                            aria-hidden="true"
                                          />
                                        )}
                                        {tab.label}
                                        <span
                                          className={`tabular-nums ${pairSeverityFilter === tab.key ? '' : tab.color || ''}`}
                                        >
                                          {tab.count}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="relative">
                                      <Search
                                        className="w-3 h-3 absolute start-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none"
                                        aria-hidden="true"
                                      />
                                      <input
                                        type="text"
                                        value={pairSearchQuery}
                                        onChange={(e) =>
                                          setPairSearchQuery(e.target.value)
                                        }
                                        placeholder={'Filter by mod name...'}
                                        aria-label={
                                          'Filter conflict pairs by mod name'
                                        }
                                        className="h-8 w-full min-w-[14rem] ps-6 pe-6 rounded-md text-[11px] bg-background/50 border border-border/40 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent placeholder:text-muted-foreground/50 sm:w-56"
                                      />
                                      {pairSearchQuery && (
                                        <button
                                          type="button"
                                          onClick={() => setPairSearchQuery('')}
                                          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground text-[10px] leading-none"
                                          aria-label={'Clear filter'}
                                          title={'Clear filter'}
                                        >
                                          ×
                                        </button>
                                      )}
                                    </div>
                                    {graphFilterMod && (
                                      <button
                                        className="rounded border border-border/40 bg-muted/25 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                                        onClick={() => setGraphFilterMod(null)}
                                      >
                                        {'Clear mod filter'}
                                      </button>
                                    )}
                                  </div>
                                </div>

                                <details className="group/conflict-tools rounded border border-border/25 bg-muted/15 px-2 py-1.5">
                                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] text-muted-foreground hover:text-foreground">
                                    <span className="inline-flex items-center gap-1.5">
                                      <ChevronRight
                                        className="h-3 w-3 transition-transform group-open/conflict-tools:rotate-90"
                                        aria-hidden="true"
                                      />
                                      {'Triage controls'}
                                    </span>
                                    <span className="font-mono text-[10px] text-muted-foreground/65">
                                      {groupByWinner ? 'grouped' : 'flat'} ·{' '}
                                      {String(openPairs.length) + ' open'}
                                    </span>
                                  </summary>
                                  <div className="mt-2 space-y-2 border-t border-border/25 pt-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setGroupByWinner((v) => !v)
                                        }
                                        className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
                                          groupByWinner
                                            ? 'border-accent/40 bg-accent/10 text-accent-foreground'
                                            : 'border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/20'
                                        }`}
                                        title={
                                          'Collapse pairs under whichever mod wins them. Off = flat list.'
                                        }
                                      >
                                        <Layers
                                          className="w-3 h-3"
                                          aria-hidden="true"
                                        />
                                        {'Group by winner'}
                                      </button>
                                      <button
                                        type="button"
                                        className="rounded border border-border/40 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors"
                                        onClick={() =>
                                          setOpenPairs(
                                            allExpanded ? [] : allPairKeys,
                                          )
                                        }
                                      >
                                        {allExpanded
                                          ? 'Collapse all pairs'
                                          : 'Expand all pairs'}
                                      </button>
                                      <button
                                        type="button"
                                        className="rounded border border-border/40 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors"
                                        onClick={() =>
                                          setShowAllTopMods((v) => !v)
                                        }
                                        disabled={
                                          hiddenTopCount <= 0 && !showAllTopMods
                                        }
                                      >
                                        {showAllTopMods
                                          ? 'Show fewer top mods'
                                          : 'Show ' +
                                            String(
                                              Math.max(hiddenTopCount, 0),
                                            ) +
                                            ' more top mods'}
                                      </button>
                                    </div>
                                    {sevFilteredTopMods.length > 0 && (
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        {visibleTopMods.map((mod) => {
                                          const isSelected =
                                            graphFilterMod === mod.modId
                                          const total =
                                            mod.high + mod.medium + mod.low
                                          return (
                                            <button
                                              key={mod.modId}
                                              onClick={() =>
                                                setGraphFilterMod(
                                                  isSelected ? null : mod.modId,
                                                )
                                              }
                                              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                                                isSelected
                                                  ? 'bg-accent/15 border-accent/40 text-accent-foreground'
                                                  : 'bg-muted/5 border-border/30 text-foreground/70 hover:bg-muted/20 hover:border-border/50'
                                              }`}
                                              title={
                                                String(mod.modName) +
                                                ' — ' +
                                                String(total) +
                                                ' conflicts (' +
                                                String(mod.high) +
                                                'H ' +
                                                String(mod.medium) +
                                                'M ' +
                                                String(mod.low) +
                                                'L) across ' +
                                                String(mod.pairs) +
                                                ' pairs'
                                              }
                                            >
                                              <span className="max-w-[150px] truncate">
                                                {mod.modName}
                                              </span>
                                              <span className="shrink-0 font-mono tabular-nums text-[10px] text-muted-foreground/80">
                                                {total}
                                              </span>
                                            </button>
                                          )
                                        })}
                                      </div>
                                    )}
                                  </div>
                                </details>
                              </div>

                              {filteredPairs.length > 0 ? (
                                <div className="max-h-[min(calc(100vh-420px),70vh)] min-h-[200px] overflow-y-auto rounded-lg border border-border/20 pe-1">
                                  <div className="p-1.5 space-y-2">
                                    {(groupByWinner
                                      ? groupedPairs
                                      : [
                                          {
                                            key: '__flat__',
                                            name: '',
                                            modId: null,
                                            pairs: filteredPairs,
                                          },
                                        ]
                                    ).map((__group) => (
                                      <div key={__group.key}>
                                        {groupByWinner &&
                                          groupedPairs.length > 1 && (
                                            <div className="px-2 pt-1 pb-1.5 flex items-baseline gap-2 text-[11px]">
                                              <CheckCircle
                                                className="w-3 h-3 text-success/70 self-center shrink-0"
                                                aria-hidden="true"
                                              />
                                              <span
                                                className={`font-semibold truncate ${__group.key.startsWith('__') ? 'text-muted-foreground' : 'text-foreground/85'}`}
                                                title={__group.name}
                                              >
                                                {__group.name || 'Pairs'}
                                              </span>
                                              <span className="text-muted-foreground/70 shrink-0">
                                                {Number(
                                                  __group.pairs.length,
                                                ) === 1
                                                  ? 'wins ' +
                                                    String(
                                                      __group.pairs.length,
                                                    ) +
                                                    ' pair'
                                                  : 'wins ' +
                                                    String(
                                                      __group.pairs.length,
                                                    ) +
                                                    ' pairs'}
                                              </span>
                                            </div>
                                          )}
                                        <Accordion
                                          type="multiple"
                                          value={openPairs}
                                          onValueChange={setOpenPairs}
                                          className="space-y-1.5"
                                        >
                                          {__group.pairs.map(
                                            (pair, pairIdx) => {
                                              const pairKey = `${pair.modA.modId}--${pair.modB.modId}`
                                              const totalFiles =
                                                pair.files.length
                                              const showAll =
                                                expandedFilePairs.has(pairKey)
                                              const visibleFiles = showAll
                                                ? pair.files
                                                : pair.files.slice(
                                                    0,
                                                    CONFLICT_FILE_LIMIT,
                                                  )
                                              const hiddenCount = showAll
                                                ? 0
                                                : totalFiles -
                                                  Math.min(
                                                    totalFiles,
                                                    CONFLICT_FILE_LIMIT,
                                                  )
                                              const maxSeverity =
                                                pair.highCount > 0
                                                  ? 'high'
                                                  : pair.mediumCount > 0
                                                    ? 'medium'
                                                    : 'low'
                                              const posA = loadOrderMap.get(
                                                pair.modA.modId,
                                              )
                                              const posB = loadOrderMap.get(
                                                pair.modB.modId,
                                              )
                                              const winner =
                                                posA != null && posB != null
                                                  ? posA > posB
                                                    ? 'A'
                                                    : posB > posA
                                                      ? 'B'
                                                      : null
                                                  : null
                                              return (
                                                <AccordionItem
                                                  key={pairKey}
                                                  value={pairKey}
                                                  className={`border rounded-lg px-0 overflow-hidden border-s-[3px] conflict-pair-enter ${
                                                    maxSeverity === 'high'
                                                      ? 'border-s-destructive/60 bg-destructive/[0.02]'
                                                      : maxSeverity === 'medium'
                                                        ? 'border-s-warning/50'
                                                        : 'border-s-primary/40'
                                                  }`}
                                                  style={{
                                                    animationDelay: `${Math.min(pairIdx * 50, 400)}ms`,
                                                  }}
                                                >
                                                  <AccordionTrigger className="px-3 py-2.5 hover:no-underline hover:bg-muted/20 [&[data-state=open]]:bg-muted/15 transition-colors">
                                                    <div className="flex min-w-0 flex-1 flex-col gap-2 text-start sm:flex-row sm:items-center sm:gap-3">
                                                      <div
                                                        className={`w-2 h-2 rounded-full shrink-0 ${
                                                          maxSeverity === 'high'
                                                            ? 'bg-destructive severity-pulse'
                                                            : maxSeverity ===
                                                                'medium'
                                                              ? 'bg-warning'
                                                              : 'bg-primary/60'
                                                        }`}
                                                        aria-hidden="true"
                                                      />
                                                      <span className="sr-only">
                                                        {maxSeverity} severity
                                                        conflict:
                                                      </span>

                                                      {(() => {
                                                        const aw =
                                                          pair.aWins ?? 0
                                                        const bw =
                                                          pair.bWins ?? 0
                                                        const tp =
                                                          pair.thirdPartyWins ??
                                                          0
                                                        const uk =
                                                          pair.unknownWins ?? 0
                                                        const aWinsAll =
                                                          aw > 0 &&
                                                          bw === 0 &&
                                                          tp === 0 &&
                                                          uk === 0
                                                        const bWinsAll =
                                                          bw > 0 &&
                                                          aw === 0 &&
                                                          tp === 0 &&
                                                          uk === 0
                                                        const tpWinsAll =
                                                          tp > 0 &&
                                                          aw === 0 &&
                                                          bw === 0
                                                        const thirdPartyName =
                                                          tp > 0
                                                            ? pair.files.find(
                                                                (f) =>
                                                                  f.winner &&
                                                                  f.winner
                                                                    .modId !==
                                                                    pair.modA
                                                                      .modId &&
                                                                  f.winner
                                                                    .modId !==
                                                                    pair.modB
                                                                      .modId,
                                                              )?.winner?.modName
                                                            : null
                                                        const fallbackWinnerSide =
                                                          aw === 0 &&
                                                          bw === 0 &&
                                                          tp === 0 &&
                                                          uk === 0
                                                            ? winner
                                                            : null

                                                        const modPill = (
                                                          mod: typeof pair.modA,
                                                          pos:
                                                            number | undefined,
                                                          isWinner: boolean,
                                                          isLoser: boolean,
                                                        ) => (
                                                          <div
                                                            className={`flex flex-col min-w-0 max-w-[44%] flex-1 px-2 py-1 rounded transition-colors ${
                                                              isWinner
                                                                ? 'bg-success/10 border border-success/25'
                                                                : isLoser
                                                                  ? 'opacity-60'
                                                                  : ''
                                                            }`}
                                                            title={
                                                              pos != null
                                                                ? String(
                                                                    mod.modName,
                                                                  ) +
                                                                  ' — load order #' +
                                                                  String(pos)
                                                                : mod.modName
                                                            }
                                                          >
                                                            <span
                                                              className={`truncate text-sm font-medium leading-tight ${isLoser ? 'line-through decoration-muted-foreground/40' : 'text-foreground/90'}`}
                                                            >
                                                              {mod.modName}
                                                            </span>
                                                            {isWinner && (
                                                              <span className="text-[10px] leading-none mt-0.5 text-success/80">
                                                                {'loads later'}
                                                              </span>
                                                            )}
                                                          </div>
                                                        )

                                                        return (
                                                          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                                                            {modPill(
                                                              pair.modA,
                                                              posA,
                                                              aWinsAll ||
                                                                fallbackWinnerSide ===
                                                                  'A',
                                                              bWinsAll ||
                                                                fallbackWinnerSide ===
                                                                  'B',
                                                            )}
                                                            <ArrowRight
                                                              className={`w-3.5 h-3.5 shrink-0 ${
                                                                aWinsAll ||
                                                                fallbackWinnerSide ===
                                                                  'A'
                                                                  ? 'text-success/60 -scale-x-100'
                                                                  : bWinsAll ||
                                                                      fallbackWinnerSide ===
                                                                        'B'
                                                                    ? 'text-success/60'
                                                                    : 'text-muted-foreground/40'
                                                              } hidden sm:block`}
                                                              aria-hidden="true"
                                                            />
                                                            {modPill(
                                                              pair.modB,
                                                              posB,
                                                              bWinsAll ||
                                                                fallbackWinnerSide ===
                                                                  'B',
                                                              aWinsAll ||
                                                                fallbackWinnerSide ===
                                                                  'A',
                                                            )}

                                                            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ms-auto sm:flex-nowrap">
                                                              <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/30 border border-border/30">
                                                                <span className="text-[11px] tabular-nums font-medium text-foreground/80">
                                                                  {totalFiles}
                                                                </span>
                                                                <span className="text-[10px] text-muted-foreground/70">
                                                                  {Number(
                                                                    totalFiles,
                                                                  ) === 1
                                                                    ? 'file'
                                                                    : 'files'}
                                                                </span>
                                                                {(pair.highCount >
                                                                  0 ||
                                                                  pair.mediumCount >
                                                                    0 ||
                                                                  pair.lowCount >
                                                                    0) && (
                                                                  <span className="flex items-center gap-0.5 ms-1 ps-1.5 border-s border-border/40">
                                                                    {pair.highCount >
                                                                      0 && (
                                                                      <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-destructive/80">
                                                                        <span
                                                                          className="w-1 h-1 rounded-full bg-destructive"
                                                                          aria-hidden="true"
                                                                        />
                                                                        {
                                                                          pair.highCount
                                                                        }
                                                                      </span>
                                                                    )}
                                                                    {pair.mediumCount >
                                                                      0 && (
                                                                      <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-warning/80">
                                                                        <span
                                                                          className="w-1 h-1 rounded-full bg-warning"
                                                                          aria-hidden="true"
                                                                        />
                                                                        {
                                                                          pair.mediumCount
                                                                        }
                                                                      </span>
                                                                    )}
                                                                    {pair.lowCount >
                                                                      0 && (
                                                                      <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-primary/70">
                                                                        <span
                                                                          className="w-1 h-1 rounded-full bg-primary/60"
                                                                          aria-hidden="true"
                                                                        />
                                                                        {
                                                                          pair.lowCount
                                                                        }
                                                                      </span>
                                                                    )}
                                                                  </span>
                                                                )}
                                                              </div>

                                                              {tpWinsAll ? (
                                                                <Tooltip>
                                                                  <TooltipTrigger
                                                                    asChild
                                                                  >
                                                                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-muted-foreground/20 text-muted-foreground cursor-help">
                                                                      {thirdPartyName
                                                                        ? String(
                                                                            thirdPartyName,
                                                                          ) +
                                                                          ' wins'
                                                                        : 'third mod wins'}
                                                                    </span>
                                                                  </TooltipTrigger>
                                                                  <TooltipContent
                                                                    side="left"
                                                                    className="text-xs max-w-xs"
                                                                  >
                                                                    {'Both ' +
                                                                      String(
                                                                        pair
                                                                          .modA
                                                                          .modName,
                                                                      ) +
                                                                      ' and ' +
                                                                      String(
                                                                        pair
                                                                          .modB
                                                                          .modName,
                                                                      ) +
                                                                      " ship these files, but a third mod loaded later overrides them both. Reordering this pair won't change the outcome."}
                                                                  </TooltipContent>
                                                                </Tooltip>
                                                              ) : aWinsAll ||
                                                                bWinsAll ? (
                                                                pair.highCount >
                                                                  0 ||
                                                                pair.mediumCount >
                                                                  0 ? (
                                                                  <Tooltip>
                                                                    <TooltipTrigger
                                                                      asChild
                                                                    >
                                                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-warning/30 bg-warning/10 text-warning cursor-help">
                                                                        <FileWarning
                                                                          className="w-3 h-3"
                                                                          aria-hidden="true"
                                                                        />
                                                                        {
                                                                          'decided'
                                                                        }
                                                                      </span>
                                                                    </TooltipTrigger>
                                                                    <TooltipContent
                                                                      side="left"
                                                                      className="text-xs max-w-xs"
                                                                    >
                                                                      {Number(
                                                                        totalFiles,
                                                                      ) === 1
                                                                        ? "Load order picks a clear winner, but the conflict is real — the losing mod's changes won't take effect. Review the file below to confirm this is the outcome you want."
                                                                        : "Load order picks a clear winner, but the conflict is real — the losing mod's changes won't take effect. Review the files below to confirm this is the outcome you want."}
                                                                    </TooltipContent>
                                                                  </Tooltip>
                                                                ) : (
                                                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-success/30 bg-success/10 text-success">
                                                                    <CheckCircle
                                                                      className="w-3 h-3"
                                                                      aria-hidden="true"
                                                                    />
                                                                    {'clean'}
                                                                  </span>
                                                                )
                                                              ) : aw > 0 ||
                                                                bw > 0 ||
                                                                tp > 0 ||
                                                                uk > 0 ? (
                                                                <Tooltip>
                                                                  <TooltipTrigger
                                                                    asChild
                                                                  >
                                                                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-warning/30 bg-warning/10 text-warning cursor-help tabular-nums">
                                                                      {'mixed ' +
                                                                        String(
                                                                          aw,
                                                                        ) +
                                                                        '/' +
                                                                        String(
                                                                          bw,
                                                                        ) +
                                                                        String(
                                                                          tp > 0
                                                                            ? `+${tp}`
                                                                            : '',
                                                                        ) +
                                                                        String(
                                                                          uk > 0
                                                                            ? `?${uk}`
                                                                            : '',
                                                                        )}
                                                                    </span>
                                                                  </TooltipTrigger>
                                                                  <TooltipContent
                                                                    side="left"
                                                                    className="text-xs max-w-xs"
                                                                  >
                                                                    {Number(
                                                                      aw,
                                                                    ) === 1
                                                                      ? String(
                                                                          pair
                                                                            .modA
                                                                            .modName,
                                                                        ) +
                                                                        ' wins ' +
                                                                        String(
                                                                          aw,
                                                                        ) +
                                                                        ' file, ' +
                                                                        String(
                                                                          pair
                                                                            .modB
                                                                            .modName,
                                                                        ) +
                                                                        ' wins ' +
                                                                        String(
                                                                          bw,
                                                                        ) +
                                                                        '.'
                                                                      : String(
                                                                          pair
                                                                            .modA
                                                                            .modName,
                                                                        ) +
                                                                        ' wins ' +
                                                                        String(
                                                                          aw,
                                                                        ) +
                                                                        ' files, ' +
                                                                        String(
                                                                          pair
                                                                            .modB
                                                                            .modName,
                                                                        ) +
                                                                        ' wins ' +
                                                                        String(
                                                                          bw,
                                                                        ) +
                                                                        '.'}
                                                                    {tp > 0 &&
                                                                      ` ${Number(tp) === 1 ? String(tp) + ' file taken by a third mod.' : String(tp) + ' files taken by a third mod.'}`}
                                                                    {uk > 0 &&
                                                                      ` ${Number(uk) === 1 ? String(uk) + ' file undetermined (mod not in Mods= list).' : String(uk) + ' files undetermined (mod not in Mods= list).'}`}
                                                                  </TooltipContent>
                                                                </Tooltip>
                                                              ) : null}
                                                            </div>
                                                          </div>
                                                        )
                                                      })()}
                                                    </div>
                                                  </AccordionTrigger>
                                                  <AccordionContent>
                                                    <div className="px-4 pb-3 pt-1 space-y-1">
                                                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                                                        {pair.highCount > 0 && (
                                                          <Badge
                                                            variant="destructive"
                                                            className="text-[11px] leading-none h-[18px] px-1.5"
                                                          >
                                                            {String(
                                                              pair.highCount,
                                                            ) +
                                                              ' high — Lua scripts'}
                                                          </Badge>
                                                        )}
                                                        {pair.mediumCount >
                                                          0 && (
                                                          <Badge
                                                            variant="warning"
                                                            className="text-[11px] leading-none h-[18px] px-1.5"
                                                          >
                                                            {String(
                                                              pair.mediumCount,
                                                            ) +
                                                              ' med — items/configs'}
                                                          </Badge>
                                                        )}
                                                        {pair.lowCount > 0 && (
                                                          <Badge
                                                            variant="secondary"
                                                            className="text-[11px] leading-none h-[18px] px-1.5 border-primary/20 text-primary"
                                                          >
                                                            {String(
                                                              pair.lowCount,
                                                            ) +
                                                              ' low — cosmetic'}
                                                          </Badge>
                                                        )}
                                                        <span className="text-[11px] text-muted-foreground/70">
                                                          {String(
                                                            visibleFiles.length,
                                                          ) + ' shown'}
                                                          {hiddenCount > 0
                                                            ? ` · ${String(hiddenCount) + ' hidden'}`
                                                            : ''}
                                                        </span>

                                                        {posA != null &&
                                                          posB != null && (
                                                            <div className="ms-auto flex items-center gap-1.5 flex-wrap">
                                                              <DisabledReason
                                                                reason={
                                                                  posA > posB
                                                                    ? String(
                                                                        pair
                                                                          .modA
                                                                          .modName,
                                                                      ) +
                                                                      ' already loads last'
                                                                    : null
                                                                }
                                                              >
                                                                <Button
                                                                  size="sm"
                                                                  variant="outline"
                                                                  className="h-7 px-2 text-[11px] gap-1"
                                                                  disabled={
                                                                    savingModOrder ||
                                                                    posA > posB
                                                                  }
                                                                  // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27: the disabled-reason branch (posA > posB, "already loads last") now lives in the DisabledReason wrapper above; this title carries only the enabled-state action hint.
                                                                  title={
                                                                    posA > posB
                                                                      ? undefined
                                                                      : 'Move ' +
                                                                        String(
                                                                          pair
                                                                            .modA
                                                                            .modName,
                                                                        ) +
                                                                        ' to load after ' +
                                                                        String(
                                                                          pair
                                                                            .modB
                                                                            .modName,
                                                                        )
                                                                  }
                                                                  onClick={(
                                                                    e,
                                                                  ) => {
                                                                    e.stopPropagation()
                                                                    promoteModOverOpponent(
                                                                      pair.modA
                                                                        .modId,
                                                                      pair.modA
                                                                        .modName,
                                                                      pair.modB
                                                                        .modId,
                                                                      pair.modB
                                                                        .modName,
                                                                    )
                                                                  }}
                                                                >
                                                                  <Wrench className="w-3 h-3" />
                                                                  <span className="truncate max-w-[140px]">
                                                                    {
                                                                      'Make A win'
                                                                    }
                                                                  </span>
                                                                </Button>
                                                              </DisabledReason>
                                                              <DisabledReason
                                                                reason={
                                                                  posB > posA
                                                                    ? String(
                                                                        pair
                                                                          .modB
                                                                          .modName,
                                                                      ) +
                                                                      ' already loads last'
                                                                    : null
                                                                }
                                                              >
                                                                <Button
                                                                  size="sm"
                                                                  variant="outline"
                                                                  className="h-7 px-2 text-[11px] gap-1"
                                                                  disabled={
                                                                    savingModOrder ||
                                                                    posB > posA
                                                                  }
                                                                  // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27: the disabled-reason branch (posB > posA, "already loads last") now lives in the DisabledReason wrapper above; this title carries only the enabled-state action hint.
                                                                  title={
                                                                    posB > posA
                                                                      ? undefined
                                                                      : 'Move ' +
                                                                        String(
                                                                          pair
                                                                            .modB
                                                                            .modName,
                                                                        ) +
                                                                        ' to load after ' +
                                                                        String(
                                                                          pair
                                                                            .modA
                                                                            .modName,
                                                                        )
                                                                  }
                                                                  onClick={(
                                                                    e,
                                                                  ) => {
                                                                    e.stopPropagation()
                                                                    promoteModOverOpponent(
                                                                      pair.modB
                                                                        .modId,
                                                                      pair.modB
                                                                        .modName,
                                                                      pair.modA
                                                                        .modId,
                                                                      pair.modA
                                                                        .modName,
                                                                    )
                                                                  }}
                                                                >
                                                                  <Wrench className="w-3 h-3" />
                                                                  <span className="truncate max-w-[140px]">
                                                                    {
                                                                      'Make B win'
                                                                    }
                                                                  </span>
                                                                </Button>
                                                              </DisabledReason>
                                                              <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                                                                title={
                                                                  'See every conflict involving ' +
                                                                  String(
                                                                    pair.modA
                                                                      .modName,
                                                                  )
                                                                }
                                                                onClick={(
                                                                  e,
                                                                ) => {
                                                                  e.stopPropagation()
                                                                  setModDetailsId(
                                                                    pair.modA
                                                                      .modId,
                                                                  )
                                                                }}
                                                              >
                                                                <Info className="w-3 h-3" />{' '}
                                                                {'Details A'}
                                                              </Button>
                                                              <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                                                                title={
                                                                  'See every conflict involving ' +
                                                                  String(
                                                                    pair.modB
                                                                      .modName,
                                                                  )
                                                                }
                                                                onClick={(
                                                                  e,
                                                                ) => {
                                                                  e.stopPropagation()
                                                                  setModDetailsId(
                                                                    pair.modB
                                                                      .modId,
                                                                  )
                                                                }}
                                                              >
                                                                <Info className="w-3 h-3" />{' '}
                                                                {'Details B'}
                                                              </Button>
                                                            </div>
                                                          )}
                                                      </div>
                                                      {visibleFiles.map((f) => {
                                                        const winnerName =
                                                          f.winner?.modId ===
                                                          pair.modA.modId
                                                            ? pair.modA.modName
                                                            : f.winner
                                                                  ?.modId ===
                                                                pair.modB.modId
                                                              ? pair.modB
                                                                  .modName
                                                              : null
                                                        const loserName =
                                                          winnerName == null
                                                            ? null
                                                            : winnerName ===
                                                                pair.modA
                                                                  .modName
                                                              ? pair.modB
                                                                  .modName
                                                              : pair.modA
                                                                  .modName
                                                        return (
                                                          <FileDiffViewer
                                                            key={`${pair.modA.modId}--${pair.modB.modId}--${f.file}`}
                                                            file={f.file}
                                                            modAId={
                                                              pair.modA.modId
                                                            }
                                                            modBId={
                                                              pair.modB.modId
                                                            }
                                                            modAName={
                                                              pair.modA.modName
                                                            }
                                                            modBName={
                                                              pair.modB.modName
                                                            }
                                                            severity={
                                                              f.severity
                                                            }
                                                            categoryLabel={
                                                              f.categoryLabel
                                                            }
                                                            winnerName={
                                                              winnerName
                                                            }
                                                            loserName={
                                                              loserName
                                                            }
                                                            overlap={f.overlap}
                                                          />
                                                        )
                                                      })}
                                                      {hiddenCount > 0 && (
                                                        <button
                                                          onClick={() =>
                                                            setExpandedFilePairs(
                                                              (prev) => {
                                                                const next =
                                                                  new Set(prev)
                                                                next.add(
                                                                  pairKey,
                                                                )
                                                                return next
                                                              },
                                                            )
                                                          }
                                                          className="text-[11px] text-muted-foreground/70 hover:text-foreground text-center pt-2 w-full transition-colors"
                                                        >
                                                          {Number(
                                                            hiddenCount,
                                                          ) === 1
                                                            ? 'Show ' +
                                                              String(
                                                                hiddenCount,
                                                              ) +
                                                              ' more file'
                                                            : 'Show ' +
                                                              String(
                                                                hiddenCount,
                                                              ) +
                                                              ' more files'}
                                                        </button>
                                                      )}
                                                    </div>
                                                  </AccordionContent>
                                                </AccordionItem>
                                              )
                                            },
                                          )}
                                        </Accordion>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <div className="text-center py-4 text-xs text-muted-foreground">
                                  {'No pairs match this filter'}
                                </div>
                              )}
                            </>
                          )
                        })()}
                    </div>
                  )}

                  {conflictSubTab === 'dependencies' &&
                    (() => {
                      const rows = depRows
                      const missingRaw = conflicts?.missingDeps || []
                      const steamRaw = conflicts?.steamDeps || []

                      if (missingRaw.length === 0 && steamRaw.length === 0) {
                        return (
                          <div className="flex items-center justify-center py-10 text-muted-foreground">
                            <div className="text-center max-w-xs">
                              <CheckCircle
                                className="w-8 h-8 mx-auto text-success/70 mb-2"
                                aria-hidden="true"
                              />
                              <p className="font-medium text-foreground text-sm">
                                {'All dependencies satisfied'}
                              </p>
                              <p className="text-xs mt-1 text-muted-foreground">
                                {
                                  "Every mod's required dependencies are present in your server config."
                                }
                              </p>
                            </div>
                          </div>
                        )
                      }

                      const handleAddDep = async (
                        workshopId: string,
                        modId: string,
                        key: string,
                      ) => {
                        if (busyRef.current) return
                        busyRef.current = true
                        setDepAdding((prev) => [...prev, key])
                        try {
                          const result = await modsApi.addMissingDep(
                            workshopId,
                            modId,
                          )
                          setDepAddResults((prev) => ({
                            ...prev,
                            [key]:
                              result.modId !== null
                                ? ('added' as const)
                                : ('error' as const),
                          }))
                        } catch {
                          setDepAddResults((prev) => ({
                            ...prev,
                            [key]: 'error' as const,
                          }))
                        } finally {
                          setDepAdding((prev) => prev.filter((k) => k !== key))
                          busyRef.current = false
                        }
                      }

                      const handleUndoDep = async (
                        workshopId: string,
                        key: string,
                      ) => {
                        if (busyRef.current) return
                        busyRef.current = true
                        setDepAdding((prev) => [...prev, key])
                        try {
                          await modsApi.batchRemove([workshopId])
                          setDepAddResults((prev) => {
                            const next = { ...prev }
                            delete next[key]
                            return next
                          })
                          fetchData()
                          toast({
                            title: 'Removed',
                            description: 'Dependency unadded.',
                          })
                        } catch (err) {
                          toast({
                            title: 'Undo failed',
                            description: getUserErrorMessage(
                              err,
                              'Could not remove the mod',
                            ),
                            variant: 'destructive',
                          })
                        } finally {
                          setDepAdding((prev) => prev.filter((k) => k !== key))
                          busyRef.current = false
                        }
                      }

                      const runDepSearch = async (
                        row: (typeof rows)[number],
                        force = false,
                      ) => {
                        const key = row.key
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
                            row.depModId || row.depName,
                            {
                              parentName: row.requiredBy,
                              parentWorkshopId: row.requiredByWsId,
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
                              error: getUserErrorMessage(err, 'Search failed'),
                              searchUrl: null,
                            },
                          }))
                        }
                      }
                      const toggleDepSearch = (row: (typeof rows)[number]) => {
                        const key = row.key
                        setDepSearchOpen((prev) => {
                          const next = new Set(prev)
                          if (next.has(key)) {
                            next.delete(key)
                            return next
                          }
                          next.add(key)
                          return next
                        })
                        if (!depSearchData[key]) runDepSearch(row)
                      }

                      const addableRows = rows.filter(
                        (r) =>
                          r.depWorkshopId && depAddResults[r.key] !== 'added',
                      )
                      const addedCount = rows.filter(
                        (r) => depAddResults[r.key] === 'added',
                      ).length

                      const handleFixAll = async () => {
                        if (
                          addableRows.length === 0 ||
                          fixingAllDeps ||
                          busyRef.current
                        )
                          return
                        busyRef.current = true
                        setFixingAllDeps(true)
                        try {
                          const response = await modsApi.addAllResolvedDeps(
                            addableRows.map((r) => ({
                              workshopId: r.depWorkshopId!,
                              modId: r.depModId || undefined,
                            })),
                          )
                          const resultByWorkshopId = new Map(
                            (response.results || []).map((r) => [
                              r.workshopId,
                              r,
                            ]),
                          )
                          setDepAddResults((prev) => {
                            const next = { ...prev }
                            for (const r of addableRows) {
                              const result = r.depWorkshopId
                                ? resultByWorkshopId.get(r.depWorkshopId)
                                : undefined
                              next[r.key] =
                                result && result.modId !== null
                                  ? ('added' as const)
                                  : ('error' as const)
                            }
                            return next
                          })
                        } catch (err) {
                          reportClientError(
                            'Failed to add all dependencies.',
                            err,
                          )
                          for (const r of addableRows) {
                            setDepAddResults((prev) => ({
                              ...prev,
                              [r.key]: 'error' as const,
                            }))
                          }
                        } finally {
                          setFixingAllDeps(false)
                          busyRef.current = false
                        }
                      }

                      return (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">
                              {String(rows.length) + ' missing'}
                              {addableRows.length <
                                rows.length - addedCount && (
                                <span className="ms-1 text-warning/80">
                                  —{' '}
                                  {String(
                                    rows.length -
                                      addableRows.length -
                                      addedCount,
                                  ) + ' unresolved'}
                                </span>
                              )}
                              {addedCount > 0 && (
                                <span className="text-success ms-1">
                                  {'(' + String(addedCount) + ' added)'}
                                </span>
                              )}
                            </span>
                            {addableRows.length > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={handleFixAll}
                                disabled={fixingAllDeps}
                                className="h-7 text-xs"
                                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint: the ternary's condition (addableRows vs rows count) is unrelated to the disabled condition (fixingAllDeps, a transient in-flight state shown by the spinner). Neither branch explains the disable. Triaged 2026-08-27.
                                title={
                                  addableRows.length < rows.length - addedCount
                                    ? 'Adds the ' +
                                      String(addableRows.length) +
                                      ' dependencies that have a known Workshop ID. ' +
                                      String(
                                        rows.length -
                                          addableRows.length -
                                          addedCount,
                                      ) +
                                      ' need a manual Workshop search.'
                                    : 'Adds all ' +
                                      String(addableRows.length) +
                                      ' resolvable dependencies in one shot.'
                                }
                              >
                                {fixingAllDeps ? (
                                  <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
                                ) : (
                                  <PlusCircle className="w-3.5 h-3.5 me-1.5" />
                                )}
                                {'Add Resolved (' +
                                  String(addableRows.length) +
                                  ')'}
                              </Button>
                            )}
                          </div>

                          <div className="rounded-lg border border-border/30 overflow-hidden divide-y divide-border/20 max-h-[min(calc(100vh-380px),70vh)] min-h-[200px] overflow-y-auto">
                            {rows.map((row) => {
                              const added = depAddResults[row.key] === 'added'
                              const adding = depAdding.includes(row.key)
                              const errored = depAddResults[row.key] === 'error'
                              const searchOpen = depSearchOpen.has(row.key)
                              const searchState = depSearchData[row.key]

                              return (
                                <div
                                  key={row.key}
                                  className={`transition-colors ${added ? 'bg-success/5' : 'bg-background/30 hover:bg-muted/10'}`}
                                >
                                  <div className="flex items-center gap-3 px-4 py-2.5">
                                    <span
                                      className={`w-2 h-2 rounded-full shrink-0 ${
                                        added
                                          ? 'bg-success'
                                          : row.depWorkshopId
                                            ? 'bg-warning'
                                            : 'bg-destructive'
                                      }`}
                                    />

                                    <div className="flex-1 min-w-0">
                                      <span
                                        className={`text-sm font-medium block truncate ${added ? 'text-success/80 line-through' : 'text-foreground/90'}`}
                                      >
                                        {row.depName}
                                      </span>
                                      <span className="text-[11px] text-muted-foreground block truncate">
                                        {'required by'}{' '}
                                        <a
                                          href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${row.requiredByWsId}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-muted-foreground/70 hover:text-foreground underline decoration-muted-foreground/30 hover:decoration-foreground/50 transition-colors"
                                        >
                                          {row.requiredBy}
                                          <span className="sr-only">
                                            {' '}
                                            {'(opens in new tab)'}
                                          </span>
                                        </a>
                                        {row.source === 'steam' && (
                                          <span className="ms-1.5 text-accent/70">
                                            {'via Workshop'}
                                          </span>
                                        )}
                                      </span>
                                    </div>

                                    <div className="shrink-0 flex items-center gap-1.5">
                                      {added ? (
                                        <>
                                          <span className="text-xs text-success flex items-center gap-1">
                                            <Check className="w-3.5 h-3.5" />{' '}
                                            {'Added'}
                                          </span>
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <Button
                                                variant="ghost"
                                                size="iconDense"
                                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                                onClick={() =>
                                                  row.depWorkshopId &&
                                                  handleUndoDep(
                                                    row.depWorkshopId,
                                                    row.key,
                                                  )
                                                }
                                                disabled={
                                                  adding || !row.depWorkshopId
                                                }
                                                aria-label={
                                                  'Undo — remove ' +
                                                  String(row.depName)
                                                }
                                              >
                                                {adding ? (
                                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                ) : (
                                                  <Trash2 className="w-3.5 h-3.5" />
                                                )}
                                              </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>
                                              {'Undo — remove from server'}
                                            </TooltipContent>
                                          </Tooltip>
                                        </>
                                      ) : errored ? (
                                        <span className="text-xs text-destructive">
                                          {'Failed'}
                                        </span>
                                      ) : row.depWorkshopId ? (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={() =>
                                            handleAddDep(
                                              row.depWorkshopId!,
                                              row.depModId || '',
                                              row.key,
                                            )
                                          }
                                          disabled={adding}
                                          className="h-7 px-2.5 text-xs"
                                        >
                                          {adding ? (
                                            <Loader2 className="w-3 h-3 animate-spin me-1" />
                                          ) : (
                                            <Plus className="w-3 h-3 me-1" />
                                          )}
                                          {'Add'}
                                        </Button>
                                      ) : (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={() => toggleDepSearch(row)}
                                          aria-expanded={searchOpen}
                                          aria-controls={`dep-search-${row.key}`}
                                          className="h-7 px-2.5 text-xs"
                                        >
                                          <Search className="w-3 h-3 me-1" />{' '}
                                          {searchOpen
                                            ? 'Hide'
                                            : 'Search Workshop'}
                                        </Button>
                                      )}
                                      {row.depWorkshopId && (
                                        <a
                                          href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${row.depWorkshopId}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1"
                                          title={'View on Steam Workshop'}
                                          aria-label={
                                            'View on Steam Workshop (opens in new tab)'
                                          }
                                        >
                                          <ExternalLink className="w-3.5 h-3.5" />
                                        </a>
                                      )}
                                    </div>
                                  </div>

                                  {searchOpen &&
                                    !row.depWorkshopId &&
                                    !added && (
                                      <div
                                        id={`dep-search-${row.key}`}
                                        className="border-t border-border/20 bg-muted/20 px-4 py-3"
                                      >
                                        {searchState?.loading ? (
                                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />{' '}
                                            {'Searching Steam Workshop for "' +
                                              String(
                                                row.depModId || row.depName,
                                              ) +
                                              '"…'}
                                          </div>
                                        ) : searchState?.error ? (
                                          <div className="flex items-center justify-between gap-2 text-xs">
                                            <span className="text-destructive break-words">
                                              {'Search failed: ' +
                                                String(searchState.error)}
                                            </span>
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              className="h-7 px-2 text-xs"
                                              onClick={() =>
                                                runDepSearch(row, true)
                                              }
                                            >
                                              {'Retry'}
                                            </Button>
                                          </div>
                                        ) : searchState &&
                                          searchState.results.length === 0 ? (
                                          <div className="space-y-2 text-xs">
                                            {searchState.steamSearchEnabled ===
                                            false ? (
                                              <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-warning">
                                                <AlertTriangle
                                                  className="w-3.5 h-3.5 mt-0.5 shrink-0"
                                                  aria-hidden="true"
                                                />
                                                <span>
                                                  <>
                                                    {
                                                      'Workshop search is disabled — add a Steam Web API key in '
                                                    }
                                                    <strong>
                                                      {'Settings → Mods'}
                                                    </strong>
                                                    {
                                                      ' to enable online Workshop search. Without it, only locally downloaded mods can be matched.'
                                                    }
                                                  </>
                                                </span>
                                              </div>
                                            ) : (
                                              <p className="text-muted-foreground">
                                                {
                                                  'No matches found on Steam Workshop.'
                                                }{' '}
                                                {searchState.variantsTried &&
                                                  searchState.variantsTried
                                                    .length > 1 && (
                                                    <span className="text-muted-foreground/70">
                                                      {'(tried: ' +
                                                        String(
                                                          searchState.variantsTried
                                                            .slice(0, 4)
                                                            .join(', '),
                                                        ) +
                                                        ')'}
                                                    </span>
                                                  )}
                                              </p>
                                            )}
                                            {searchState.searchUrl && (
                                              <a
                                                href={searchState.searchUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 text-accent/80 hover:text-accent"
                                              >
                                                <ExternalLink className="w-3 h-3" />{' '}
                                                {
                                                  'Open Workshop search in browser'
                                                }
                                              </a>
                                            )}
                                          </div>
                                        ) : searchState &&
                                          searchState.results.length > 0 ? (
                                          <div className="space-y-2">
                                            <p className="text-[11px] text-muted-foreground">
                                              {Number(
                                                searchState.results.length,
                                              ) === 1
                                                ? String(
                                                    searchState.results.length,
                                                  ) +
                                                  ' possible match — pick the right one and click Add. Steam search is fuzzy, so verify the title before adding.'
                                                : String(
                                                    searchState.results.length,
                                                  ) +
                                                  ' possible matches — pick the right one and click Add. Steam search is fuzzy, so verify the title before adding.'}
                                            </p>
                                            {searchState.steamSearchEnabled ===
                                              false && (
                                              <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning">
                                                <AlertTriangle
                                                  className="w-3 h-3 mt-0.5 shrink-0"
                                                  aria-hidden="true"
                                                />
                                                <span>
                                                  {
                                                    'Only locally downloaded mods were searched. Add a Steam Web API key in Settings → Mods to also search the Steam Workshop online.'
                                                  }
                                                </span>
                                              </div>
                                            )}
                                            <ul className="space-y-1.5 max-h-72 overflow-y-auto pe-1">
                                              {searchState.results.map(
                                                (hit) => {
                                                  const candidateKey = `${row.key}::${hit.workshopId}`
                                                  const candAdding =
                                                    depAdding.includes(
                                                      candidateKey,
                                                    )
                                                  const candAdded =
                                                    depAddResults[
                                                      candidateKey
                                                    ] === 'added'
                                                  const candErrored =
                                                    depAddResults[
                                                      candidateKey
                                                    ] === 'error'
                                                  return (
                                                    <li
                                                      key={hit.workshopId}
                                                      className="flex items-start gap-2 rounded-md border border-border/30 bg-background/50 px-2.5 py-2"
                                                    >
                                                      <span
                                                        className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${hit.isDownloaded ? 'bg-success' : 'bg-accent/60'}`}
                                                        aria-hidden="true"
                                                      />
                                                      <div className="flex-1 min-w-0">
                                                        <div className="flex items-baseline gap-2 flex-wrap">
                                                          <a
                                                            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${hit.workshopId}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-sm font-medium text-foreground/90 hover:text-foreground truncate"
                                                          >
                                                            {hit.modName}
                                                          </a>
                                                          {hit.modId && (
                                                            <code className="text-[10px] text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">
                                                              {hit.modId}
                                                            </code>
                                                          )}
                                                          {hit.isDownloaded && (
                                                            <span className="text-[10px] text-success">
                                                              {'downloaded'}
                                                            </span>
                                                          )}
                                                          {typeof hit.subscriberCount ===
                                                            'number' &&
                                                            hit.subscriberCount >
                                                              0 && (
                                                              <span className="text-[10px] text-muted-foreground/70">
                                                                {Number(
                                                                  hit.subscriberCount,
                                                                ) === 1
                                                                  ? String(
                                                                      hit.subscriberCount.toLocaleString(
                                                                        'en',
                                                                      ),
                                                                    ) + ' sub'
                                                                  : String(
                                                                      hit.subscriberCount.toLocaleString(
                                                                        'en',
                                                                      ),
                                                                    ) + ' subs'}
                                                              </span>
                                                            )}
                                                        </div>
                                                        {hit.description && (
                                                          <p className="text-[11px] text-muted-foreground/80 line-clamp-2 mt-0.5">
                                                            {hit.description}
                                                          </p>
                                                        )}
                                                      </div>
                                                      <div className="shrink-0">
                                                        {candAdded ? (
                                                          <span className="text-xs text-success flex items-center gap-1">
                                                            <Check className="w-3.5 h-3.5" />{' '}
                                                            {'Added'}
                                                          </span>
                                                        ) : candErrored ? (
                                                          <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-7 px-2 text-xs"
                                                            onClick={() =>
                                                              handleAddDep(
                                                                hit.workshopId,
                                                                hit.modId ||
                                                                  row.depModId ||
                                                                  '',
                                                                candidateKey,
                                                              )
                                                            }
                                                          >
                                                            {'Retry'}
                                                          </Button>
                                                        ) : (
                                                          <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="h-7 px-2.5 text-xs"
                                                            disabled={
                                                              candAdding
                                                            }
                                                            onClick={() =>
                                                              handleAddDep(
                                                                hit.workshopId,
                                                                hit.modId ||
                                                                  row.depModId ||
                                                                  '',
                                                                candidateKey,
                                                              )
                                                            }
                                                          >
                                                            {candAdding ? (
                                                              <Loader2 className="w-3 h-3 animate-spin me-1" />
                                                            ) : (
                                                              <Plus className="w-3 h-3 me-1" />
                                                            )}
                                                            {'Add'}
                                                          </Button>
                                                        )}
                                                      </div>
                                                    </li>
                                                  )
                                                },
                                              )}
                                            </ul>
                                            {searchState.searchUrl && (
                                              <a
                                                href={searchState.searchUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors"
                                              >
                                                <ExternalLink className="w-3 h-3" />{' '}
                                                {
                                                  'Not here? Open Workshop search in browser'
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
                      )
                    })()}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={modDetailsId != null}
        onOpenChange={(open) => {
          if (!open) setModDetailsId(null)
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto sm:max-h-[80vh]">
          {(() => {
            if (!modDetailsId || !conflicts) return null
            const allPairs = conflicts.pairs ?? []
            const myPairs = allPairs.filter(
              (p) =>
                p.modA.modId === modDetailsId || p.modB.modId === modDetailsId,
            )
            if (myPairs.length === 0) {
              return (
                <>
                  <DialogHeader>
                    <DialogTitle>{'No conflicts'}</DialogTitle>
                    <DialogDescription>
                      {'This mod has no recorded conflicts in the latest scan.'}
                    </DialogDescription>
                  </DialogHeader>
                </>
              )
            }
            const firstHit = myPairs[0]
            const modName =
              firstHit.modA.modId === modDetailsId
                ? firstHit.modA.modName
                : firstHit.modB.modName
            const pos = loadOrderMap.get(modDetailsId)
            let winsPairs = 0,
              losesPairs = 0,
              tiedPairs = 0
            let totalFiles = 0
            const extCounts = new Map<string, number>()
            for (const p of myPairs) {
              totalFiles += p.files.length
              for (const f of p.files) {
                const dot = f.file.lastIndexOf('.')
                const ext =
                  dot >= 0 ? f.file.slice(dot + 1).toLowerCase() : '(no ext)'
                extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1)
              }
              const myPos = loadOrderMap.get(modDetailsId)
              const otherId =
                p.modA.modId === modDetailsId ? p.modB.modId : p.modA.modId
              const otherPos = loadOrderMap.get(otherId)
              if (myPos != null && otherPos != null) {
                if (myPos > otherPos) winsPairs++
                else if (myPos < otherPos) losesPairs++
                else tiedPairs++
              }
            }
            const topExts = Array.from(extCounts.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
            const sortedPairs = [...myPairs].sort(
              (a, b) =>
                b.highCount - a.highCount ||
                b.mediumCount - a.mediumCount ||
                b.files.length - a.files.length,
            )

            const jumpToPair = (pair: (typeof myPairs)[number]) => {
              const key = `${pair.modA.modId}--${pair.modB.modId}`
              setOpenPairs((prev) =>
                prev.includes(key) ? prev : [...prev, key],
              )
              setModDetailsId(null)
              setTimeout(() => {
                const el = document.querySelector(
                  `[data-state][value="${CSS.escape(key)}"]`,
                ) as HTMLElement | null
                el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }, 120)
            }

            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-base flex items-center gap-2 min-w-0">
                    <Info className="w-4 h-4 shrink-0 text-accent" />
                    <span className="truncate">{modName}</span>
                    {pos != null && (
                      <span className="text-[11px] font-normal text-muted-foreground shrink-0">
                        {'load #' + String(pos)}
                      </span>
                    )}
                  </DialogTitle>
                  <DialogDescription>
                    {String(myPairs.length) +
                      ' pairs · ' +
                      String(totalFiles) +
                      ' overlapping files'}
                    {(winsPairs > 0 || losesPairs > 0 || tiedPairs > 0) && (
                      <>
                        {' '}
                        ·{' '}
                        {'wins ' +
                          String(winsPairs) +
                          ' · loses ' +
                          String(losesPairs)}
                        {tiedPairs > 0
                          ? ` · ${'tied ' + String(tiedPairs)}`
                          : ''}
                      </>
                    )}
                  </DialogDescription>
                </DialogHeader>

                {topExts.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap pb-1 border-b border-border/30">
                    <span className="text-[11px] text-muted-foreground">
                      {'Top file types:'}
                    </span>
                    {topExts.map(([ext, count]) => (
                      <Badge
                        key={ext}
                        variant="secondary"
                        className="text-[10px] h-5 px-1.5 tabular-nums"
                      >
                        .{ext}{' '}
                        <span className="text-muted-foreground/80 ms-1">
                          {count}
                        </span>
                      </Badge>
                    ))}
                  </div>
                )}

                <ul className="space-y-1.5">
                  {sortedPairs.map((p) => {
                    const isA = p.modA.modId === modDetailsId
                    const other = isA ? p.modB : p.modA
                    const otherPos = loadOrderMap.get(other.modId)
                    const myPos = loadOrderMap.get(modDetailsId)
                    const winning =
                      myPos != null && otherPos != null
                        ? myPos > otherPos
                          ? 'win'
                          : myPos < otherPos
                            ? 'lose'
                            : 'tie'
                        : 'unknown'
                    const maxSev =
                      p.highCount > 0
                        ? 'high'
                        : p.mediumCount > 0
                          ? 'medium'
                          : 'low'
                    return (
                      <li
                        key={`${p.modA.modId}--${p.modB.modId}`}
                        className={`flex items-center gap-2 rounded-md border px-2.5 py-2 ${
                          maxSev === 'high'
                            ? 'border-destructive/40 bg-destructive/[0.03]'
                            : maxSev === 'medium'
                              ? 'border-warning/40 bg-warning/[0.03]'
                              : 'border-border/40'
                        }`}
                      >
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            maxSev === 'high'
                              ? 'bg-destructive'
                              : maxSev === 'medium'
                                ? 'bg-warning'
                                : 'bg-primary/60'
                          }`}
                          aria-hidden="true"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">
                            {other.modName}
                          </div>
                          <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
                            <span className="tabular-nums">
                              {Number(p.files.length) === 1
                                ? String(p.files.length) + ' file'
                                : String(p.files.length) + ' files'}
                            </span>
                            {p.highCount > 0 && (
                              <span className="text-destructive/80 tabular-nums">
                                {String(p.highCount) + ' high'}
                              </span>
                            )}
                            {p.mediumCount > 0 && (
                              <span className="text-warning/80 tabular-nums">
                                {String(p.mediumCount) + ' med'}
                              </span>
                            )}
                            {p.lowCount > 0 && (
                              <span className="text-primary/70 tabular-nums">
                                {String(p.lowCount) + ' low'}
                              </span>
                            )}
                            {otherPos != null && (
                              <span>{'load #' + String(otherPos)}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {winning === 'win' && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] h-5 px-1.5 border-success/30 bg-success/10 text-success"
                            >
                              {'wins'}
                            </Badge>
                          )}
                          {winning === 'lose' && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] h-5 px-1.5 border-warning/30 bg-warning/10 text-warning"
                            >
                              {'loses'}
                            </Badge>
                          )}
                          {winning === 'lose' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[10px] gap-1"
                              disabled={savingModOrder}
                              onClick={() =>
                                promoteModOverOpponent(
                                  modDetailsId,
                                  modName,
                                  other.modId,
                                  other.modName,
                                )
                              }
                            >
                              <Wrench className="w-3 h-3" /> {'Win it'}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => jumpToPair(p)}
                          >
                            {'View'}
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>

                <DialogFooter className="pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setModDetailsId(null)}
                  >
                    {'Close'}
                  </Button>
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>
    </div>
  )
}
