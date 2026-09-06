import { useEffect, useMemo, useState, type Dispatch, type SetStateAction, type MutableRefObject } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { RefreshCw, Plus, Trash2, ExternalLink, AlertTriangle, CheckCircle, Search, ChevronRight, Check, Info, Layers, Loader2, Shield, ShieldAlert, FileWarning, Wrench, Network, GitBranch, PlusCircle, ArrowRight } from 'lucide-react'
import type { ConflictScanResult, ScanStreamConflictFound } from '@/types'
import { modsApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { FileDiffViewer } from '@/components/FileDiffViewer'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DisabledReason } from '@/components/DisabledReason'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { CONFLICT_FILE_LIMIT, useLocalStorageState, type DepSearchState } from '@/lib/modsShared'

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
  promoteModOverOpponent: (winnerModId: string, winnerName: string, loserModId: string, loserName: string) => Promise<void>
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
  conflicts, conflictsLoading, conflictsError, conflictsStale, lastScanTime, scanConflicts,
  scanProgress, scanCurrentMod, scanModsScanned, scanTotalMods, streamConflicts, focusDependencies,
  fetchData, busyRef, savingModOrder, promoteModOverOpponent, toast,
  depSearchOpen, setDepSearchOpen, depSearchData, setDepSearchData,
  depAdding, setDepAdding, depAddResults, setDepAddResults,
}: ConflictsPanelProps) {
  const { t, i18n } = useTranslation('conflictsPanel')
  const [openPairs, setOpenPairs] = useState<string[]>([])
  const [conflictSubTab, setConflictSubTab] = useLocalStorageState<'network' | 'dependencies'>('zcp:mods:conflicts:subTab', 'network')
  const [pairSeverityFilter, setPairSeverityFilter] = useLocalStorageState<'all' | 'real' | 'high' | 'medium' | 'low'>('zcp:mods:conflicts:severity', 'real')
  const [groupByWinner, setGroupByWinner] = useLocalStorageState<boolean>('zcp:mods:conflicts:groupByWinner', true)
  const [pairSearchQuery, setPairSearchQuery] = useLocalStorageState<string>('zcp:mods:conflicts:search', '')
  const [showAllTopMods, setShowAllTopMods] = useState<boolean>(false)
  const [graphFilterMod, setGraphFilterMod] = useState<string | null>(null)
  const [expandedFilePairs, setExpandedFilePairs] = useState<Set<string>>(new Set())
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
      ? conflicts.pairs.filter(p => p.modA.modId === graphFilterMod || p.modB.modId === graphFilterMod)
      : conflicts.pairs
    return {
      all: allPairs.length,
      real: allPairs.filter(p => p.highCount > 0 || p.mediumCount > 0).length,
      high: allPairs.filter(p => p.highCount > 0).length,
      medium: allPairs.filter(p => p.mediumCount > 0).length,
      low: allPairs.filter(p => p.lowCount > 0).length,
    }
  }, [conflicts?.pairs, graphFilterMod])

  const depRows = useMemo(() => {
    const missingDeps = conflicts?.missingDeps || []
    const steamDeps = conflicts?.steamDeps || []
    type DepRow = {
      key: string; requiredBy: string; requiredByWsId: string; depName: string
      depModId: string | null; depWorkshopId: string | null; source: 'local' | 'steam'
    }
    const rows: DepRow[] = []
    for (const sd of steamDeps) {
      rows.push({
        key: `steam-${sd.parentWorkshopId}-${sd.childWorkshopId}`,
        requiredBy: sd.parentName, requiredByWsId: sd.parentWorkshopId,
        depName: sd.childName, depModId: null, depWorkshopId: sd.childWorkshopId, source: 'steam',
      })
    }
    for (const dep of missingDeps) {
      const alreadyCovered = steamDeps.some(sd =>
        sd.parentWorkshopId === dep.workshopId && dep.resolvedWorkshopId && sd.childWorkshopId === dep.resolvedWorkshopId
      )
      if (alreadyCovered) continue
      rows.push({
        key: `local-${dep.workshopId}-${dep.missingDep}`,
        requiredBy: dep.modName, requiredByWsId: dep.workshopId,
        depName: dep.resolvedModName || dep.missingDep,
        depModId: dep.missingDep, depWorkshopId: dep.resolvedWorkshopId || null, source: 'local',
      })
    }
    return rows
  }, [conflicts?.missingDeps, conflicts?.steamDeps])

  const dedupedDepCount = useMemo(() => {
    const missingDeps = conflicts?.missingDeps || []
    const steamDeps = conflicts?.steamDeps || []
    let count = steamDeps.length
    for (const dep of missingDeps) {
      const alreadyCovered = steamDeps.some(sd =>
        sd.parentWorkshopId === dep.workshopId && dep.resolvedWorkshopId && sd.childWorkshopId === dep.resolvedWorkshopId
      )
      if (!alreadyCovered) count++
    }
    return count
  }, [conflicts?.missingDeps, conflicts?.steamDeps])

  const loadOrderMap = useMemo(() => {
    const entries: [string, number][] = (conflicts?.modLoadOrder ?? []).map((id, i) => [id, i + 1] as [string, number])
    return new Map(entries)
  }, [conflicts?.modLoadOrder])

  const filteredPairs = useMemo(() => {
    if (!conflicts?.pairs?.length) return []
    let pairs = graphFilterMod
      ? conflicts.pairs.filter(p => p.modA.modId === graphFilterMod || p.modB.modId === graphFilterMod)
      : conflicts.pairs
    if (pairSeverityFilter !== 'all') {
      pairs = pairs.filter(p => {
        if (pairSeverityFilter === 'real') return p.highCount > 0 || p.mediumCount > 0
        if (pairSeverityFilter === 'high') return p.highCount > 0
        if (pairSeverityFilter === 'medium') return p.mediumCount > 0
        if (pairSeverityFilter === 'low') return p.lowCount > 0
        return true
      })
    }
    const q = pairSearchQuery.trim().toLowerCase()
    if (q) {
      pairs = pairs.filter(p =>
        p.modA.modName.toLowerCase().includes(q) ||
        p.modB.modName.toLowerCase().includes(q) ||
        p.modA.modId.toLowerCase().includes(q) ||
        p.modB.modId.toLowerCase().includes(q)
      )
    }
    return pairs
  }, [conflicts?.pairs, graphFilterMod, pairSeverityFilter, pairSearchQuery])

  const topConflictingMods = useMemo(() => {
    if (!conflicts?.pairs?.length) return []
    const modStats = new Map<string, { modId: string; modName: string; pairs: number; high: number; medium: number; low: number; files: number }>()
    for (const pair of conflicts.pairs) {
      for (const mod of [pair.modA, pair.modB]) {
        if (!modStats.has(mod.modId)) {
          modStats.set(mod.modId, { modId: mod.modId, modName: mod.modName, pairs: 0, high: 0, medium: 0, low: 0, files: 0 })
        }
        const s = modStats.get(mod.modId)!
        s.pairs++
        s.high += pair.highCount
        s.medium += pair.mediumCount
        s.low += pair.lowCount
        s.files += pair.files.length
      }
    }
    return Array.from(modStats.values()).sort((a, b) => (b.high - a.high) || (b.medium - a.medium) || (b.pairs - a.pairs)).slice(0, 15)
  }, [conflicts?.pairs])

  const groupedPairs = useMemo(() => {
    if (!filteredPairs.length) return [] as Array<{ key: string; name: string; modId: string | null; pairs: typeof filteredPairs }>
    const groups = new Map<string, { key: string; name: string; modId: string | null; pairs: typeof filteredPairs }>()
    for (const pair of filteredPairs) {
      const aw = pair.aWins ?? 0, bw = pair.bWins ?? 0, tp = pair.thirdPartyWins ?? 0, uk = pair.unknownWins ?? 0
      const aWinsAll = aw > 0 && bw === 0 && tp === 0 && uk === 0
      const bWinsAll = bw > 0 && aw === 0 && tp === 0 && uk === 0
      const tpWinsAll = tp > 0 && aw === 0 && bw === 0
      let key: string, name: string, modId: string | null
      if (aWinsAll) { key = pair.modA.modId; name = pair.modA.modName; modId = pair.modA.modId }
      else if (bWinsAll) { key = pair.modB.modId; name = pair.modB.modName; modId = pair.modB.modId }
      else if (tpWinsAll) {
        const tpMod = pair.files.find(f => f.winner && f.winner.modId !== pair.modA.modId && f.winner.modId !== pair.modB.modId)?.winner
        key = tpMod?.modId ?? '__third_party__'
        name = tpMod?.modName ?? t('otherMod')
        modId = tpMod?.modId ?? null
      } else if (aw === 0 && bw === 0 && tp === 0 && uk === 0) {
        const posA = loadOrderMap.get(pair.modA.modId)
        const posB = loadOrderMap.get(pair.modB.modId)
        if (posA != null && posB != null && posA !== posB) {
          if (posA > posB) { key = pair.modA.modId; name = pair.modA.modName; modId = pair.modA.modId }
          else { key = pair.modB.modId; name = pair.modB.modName; modId = pair.modB.modId }
        } else {
          key = '__split__'; name = t('mixedUnresolved'); modId = null
        }
      } else {
        key = '__split__'; name = t('mixedUnresolved'); modId = null
      }
      if (!groups.has(key)) groups.set(key, { key, name, modId, pairs: [] })
      groups.get(key)!.pairs.push(pair)
    }
    return [...groups.values()].sort((a, b) => {
      const aSpecial = a.key.startsWith('__'), bSpecial = b.key.startsWith('__')
      if (aSpecial !== bSpecial) return aSpecial ? 1 : -1
      return b.pairs.length - a.pairs.length
    })
  }, [filteredPairs, loadOrderMap, t])

  useEffect(() => {
    if (!conflicts) return
    if (pairSeverityFilter === 'real' && severityCounts.real === 0 && severityCounts.low > 0) {
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
              {t('title')}
            </CardTitle>
            <CardDescription className="mt-1">
              {t('subtitle')}
            </CardDescription>
          </div>
          {conflicts && !conflictsLoading && (
            <div className="flex items-center gap-2 shrink-0">
              {lastScanTime && (
                <span className="text-[11px] tabular-nums text-muted-foreground/70 hidden sm:inline">
                  {t('lastScan', { time: new Date(lastScanTime).toLocaleTimeString(i18n.language) })}
                </span>
              )}
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={scanConflicts} disabled={conflictsLoading}>
                <RefreshCw className="w-3.5 h-3.5 me-1.5" />
                {t('rescan')}
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
                <div className="flex items-center justify-between text-xs text-muted-foreground" aria-live="polite">
                  <span>{scanCurrentMod || t('preparingToScan')}</span>
                  {scanProgress > 0 && <span className="tabular-nums">{scanProgress}%</span>}
                </div>
                <div className={`h-1.5 rounded-full bg-border/50 overflow-hidden ${scanProgress === 0 ? 'scan-indeterminate' : ''}`} role="progressbar" aria-valuenow={scanProgress} aria-valuemin={0} aria-valuemax={100} aria-label={t('scanProgressAria')}>
                  {scanProgress > 0 && (
                    <div
                      className={`h-full rounded-full bg-primary transition-all duration-500 ease-out ${scanProgress > 0 && scanProgress < 100 ? 'scan-progress-glow' : ''} ${scanProgress >= 100 ? 'scan-complete-flash' : ''}`}
                      style={{ width: `${scanProgress}%` }}
                    />
                  )}
                </div>
                {scanTotalMods > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('modsScannedProgress', { scanned: scanModsScanned, total: scanTotalMods })}
                  </p>
                )}
              </div>

              {streamConflicts.length > 0 && (
                <div className="rounded-lg border border-border/30 bg-muted/10 overflow-hidden" aria-live="polite">
                  <div className="px-3 py-1.5 text-[11px] font-medium text-warning/80 border-b border-border/30 bg-warning/5">
                    {(() => { const n = streamConflicts[streamConflicts.length - 1]?.conflictsSoFar ?? streamConflicts.length; return t('conflictsFoundSoFar', { count: n }) })()}
                  </div>
                  <div className="max-h-32 overflow-y-auto">
                    {streamConflicts.slice(-8).map((c) => (
                      <div key={`${c.file}:${c.conflictsSoFar}`} className={`flex items-center gap-2 px-3 py-1 text-[11px] conflict-stream-enter ${
                        c.severity === 'high' ? 'bg-destructive/5' : c.severity === 'medium' ? 'bg-warning/5' : ''
                      }`}>
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          c.severity === 'high' ? 'bg-destructive severity-pulse' : c.severity === 'medium' ? 'bg-warning' : 'bg-primary/50'
                        }`} aria-hidden="true" />
                        <span className="sr-only">{t('severityPrefix', { severity: c.severity })}</span>
                        <span className="font-mono text-foreground/70 truncate flex-1">{c.file}</span>
                        <span className="text-muted-foreground/70 shrink-0">{t('inNMods', { count: c.mods.length })}</span>
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
              <ShieldAlert className="w-10 h-10 mx-auto text-destructive/60" aria-hidden="true" />
              <div>
                <p className="font-medium text-foreground text-sm">{t('scanFailed')}</p>
                <p className="text-xs mt-1.5 text-muted-foreground break-words" dir="auto">{conflictsError}</p>
                <p className="text-[11px] mt-2 text-muted-foreground leading-relaxed">
                  {t('scanFailedHint')}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={scanConflicts} disabled={conflictsLoading}>
                <RefreshCw className="w-3.5 h-3.5 me-1.5" /> {t('retry')}
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
                <h3 className="text-base font-semibold text-foreground">{t('readyToScanTitle')}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground max-w-md leading-relaxed">
                  {t('readyToScanDesc')}
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">
                <div className="rounded-lg border border-border/50 bg-muted/15 px-3 py-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <FileWarning className="w-3.5 h-3.5 text-warning" aria-hidden="true" />
                    <span className="text-xs font-semibold text-foreground/90">{t('fileOverlapsTitle')}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    {t('fileOverlapsDesc')}
                  </p>
                </div>
                <div className="rounded-lg border border-border/50 bg-muted/15 px-3 py-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Layers className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                    <span className="text-xs font-semibold text-foreground/90">{t('loadOrderWinnersTitle')}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    {t('loadOrderWinnersDesc')}
                  </p>
                </div>
                <div className="rounded-lg border border-border/50 bg-muted/15 px-3 py-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <GitBranch className="w-3.5 h-3.5 text-destructive" aria-hidden="true" />
                    <span className="text-xs font-semibold text-foreground/90">{t('missingDepsTitle')}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    {t('missingDepsDesc')}
                  </p>
                </div>
              </div>

              <div className="flex flex-col items-center gap-2">
                <Button onClick={scanConflicts} disabled={conflictsLoading} className="min-w-[200px]">
                  <Shield className="w-4 h-4 me-2" aria-hidden="true" />
                  {t('scanForConflicts')}
                </Button>
                <p className="text-[11px] text-muted-foreground/70 flex items-center gap-1.5">
                  <Info className="w-3 h-3" aria-hidden="true" />
                  {t('readOnlyHint')}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className={`space-y-3 stagger-in relative ${conflictsLoading ? 'pointer-events-none' : ''}`}>
            {conflictsLoading && (
              <div className="absolute inset-0 bg-background/60 backdrop-blur-[1px] z-10 flex items-center justify-center rounded-lg transition-opacity duration-200 animate-in fade-in" role="status" aria-busy="true">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
                  {t('scanningMods')}
                </div>
              </div>
            )}

            {conflictsError && (() => {
              const recovered = !!conflicts
              const isCacheFallback = /cached results/i.test(conflictsError)
              const tone = recovered || isCacheFallback
                ? 'border-warning/30 bg-warning/5 text-warning'
                : 'border-destructive/30 bg-destructive/5 text-destructive'
              return (
                <div className={`rounded-lg border p-3 flex items-center gap-2 text-xs ${tone}`} role={isCacheFallback ? 'status' : 'alert'}>
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span className="flex-1 min-w-0 break-words" dir="auto">{conflictsError}</span>
                  <Button variant="ghost" size="sm" className="h-9 px-3 text-xs shrink-0" onClick={scanConflicts} disabled={conflictsLoading}>
                    {recovered ? t('rescan') : t('retry')}
                  </Button>
                </div>
              )
            })()}

            {conflictsStale && !conflictsLoading && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 flex items-center gap-2 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-warning" aria-hidden="true" />
                <span className="flex-1 text-muted-foreground">{t('modListChanged')}</span>
                <Button variant="outline" size="sm" className="h-9 px-3 text-xs shrink-0" onClick={scanConflicts} disabled={conflictsLoading}>
                  {t('rescan')}
                </Button>
              </div>
            )}

            {(conflicts.idCollisions?.filter(c => c.active).length ?? 0) > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                <div className="flex items-start gap-2 text-xs">
                  <ShieldAlert className="w-4 h-4 shrink-0 text-destructive mt-0.5" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-destructive">
                      {t('idCollisionTitle', { count: conflicts.idCollisions!.filter(c => c.active).length })}
                    </p>
                    <p className="text-muted-foreground mt-0.5 leading-relaxed">
                      {t('idCollisionDesc')}
                    </p>
                  </div>
                </div>
                <div className="space-y-1.5 ps-6">
                  {conflicts.idCollisions!.filter(c => c.active).map(coll => (
                    <div key={coll.modId} className="text-[11px] flex items-baseline gap-2 flex-wrap">
                      <code className="font-mono px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-medium shrink-0">{coll.modId}</code>
                      <span className="text-muted-foreground">{t('declaredBy')}</span>
                      {coll.sources.map((s, i) => (
                        <span key={s.workshopId} className="inline-flex items-center gap-1 text-foreground/80">
                          <a
                            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${s.workshopId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline truncate max-w-[200px]"
                            title={t('workshopIdSuffix', { name: s.modName, id: s.workshopId })}
                          >
                            {s.modName}
                          </a>
                          {i < coll.sources.length - 1 && <span className="text-muted-foreground/50">·</span>}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(() => {
              const f = pairSeverityFilter
              const headlineCount = (
                f === 'all' ? severityCounts.all
                : f === 'real' ? severityCounts.real
                : f === 'high' ? severityCounts.high
                : f === 'medium' ? severityCounts.medium
                : severityCounts.low
              ) ?? 0
              const headlineLabel = f === 'all'
                ? t('overlappingModPairs', { count: headlineCount })
                : f === 'real' ? t('realConflicts', { count: headlineCount })
                : f === 'high' ? t('criticalConflicts', { count: headlineCount })
                : f === 'medium' ? t('mediumConflicts', { count: headlineCount })
                : t('lowSeverityOverlaps', { count: headlineCount })
              const tone = headlineCount > 0 && (f === 'real' || f === 'high' || f === 'medium')
                ? 'warning'
                : headlineCount > 0
                  ? 'muted'
                  : 'success'
              const isWarn = tone === 'warning'
              const isSuccess = tone === 'success'
              return (
            conflicts.modsScanned > 0 ? (
              <div
                className={`relative rounded-lg border overflow-hidden ${
                  isWarn ? 'border-warning/30 bg-warning/[0.04]'
                    : isSuccess ? 'border-success/30 bg-success/[0.04]'
                    : 'border-border/40 bg-muted/[0.04]'
                }`}
                role="status"
                aria-live="polite"
              >
                <div className={`absolute inset-y-0 left-0 w-1 ${isWarn ? 'bg-warning/60' : isSuccess ? 'bg-success/60' : 'bg-muted-foreground/40'}`} aria-hidden="true" />

                <div className="flex items-stretch">
                  <div className="flex items-center gap-3.5 px-4 py-3 flex-1 min-w-0">
                    {isWarn ? (
                      <FileWarning className="w-5 h-5 text-warning shrink-0" aria-hidden="true" />
                    ) : isSuccess ? (
                      <CheckCircle className="w-5 h-5 text-success shrink-0" aria-hidden="true" />
                    ) : (
                      <Info className="w-5 h-5 text-muted-foreground shrink-0" aria-hidden="true" />
                    )}
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span
                        className={`text-2xl font-semibold leading-none tabular-nums ${
                          isWarn ? 'text-warning' : isSuccess ? 'text-success' : 'text-foreground/80'
                        }`}
                      >
                        {headlineCount}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground/90 leading-tight">
                          {headlineCount > 0 ? headlineLabel : t('noConflictsInView')}
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                          {f === 'all' || f === 'low'
                            ? [
                                t('realConflictsCount', { count: severityCounts.real }),
                                t('lowSeverityCount', { count: severityCounts.low }),
                                t('modsScannedCount', { count: conflicts.modsScanned }),
                              ].join(' · ')
                            : [
                                t('totalOverlappingPairsCount', { count: severityCounts.all }),
                                t('modsScannedCount', { count: conflicts.modsScanned }),
                              ].join(' · ')}
                        </p>
                      </div>
                    </div>
                    {dedupedDepCount > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setConflictSubTab('dependencies')}
                            className="ms-auto inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/15 transition-colors shrink-0"
                          >
                            <GitBranch className="w-3 h-3" aria-hidden="true" />
                            {t('missingDepsCount', { count: dedupedDepCount })}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs max-w-xs">
                          <p>{t('missingDepsTooltipLine1')}</p>
                          <p className="text-muted-foreground mt-0.5">{t('missingDepsTooltipLine2')}</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>

                  <div className="flex items-center gap-4 border-s border-border/30 px-4 py-3 text-[11px] bg-background/30">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-center cursor-help">
                          <div className="tabular-nums font-semibold text-foreground/80 leading-none">{conflicts.modsScanned}</div>
                          <div className="text-muted-foreground mt-1 leading-none">{t('scanned')}</div>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs max-w-xs space-y-0.5">
                        <p>{t('activeModsCompared', { count: conflicts.modsScanned })}</p>
                        {(conflicts.modsSkippedInactive ?? 0) > 0 && <p className="text-muted-foreground">{t('inactiveModsCount', { count: conflicts.modsSkippedInactive })}</p>}
                        {(conflicts.modsNotFound ?? 0) > 0 && <p className="text-muted-foreground">{t('notDownloadedCount', { count: conflicts.modsNotFound })}</p>}
                      </TooltipContent>
                    </Tooltip>
                    {(conflicts.modsNotFound ?? 0) > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="text-center cursor-help">
                            <div className="tabular-nums font-semibold text-muted-foreground leading-none">{conflicts.modsNotFound}</div>
                            <div className="text-muted-foreground mt-1 leading-none">{t('notOnDisk')}</div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs max-w-xs">
                          {t('notOnDiskTooltip')}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {(conflicts.identicalSkipped ?? 0) > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="text-center cursor-help opacity-70">
                            <div className="tabular-nums font-medium text-success/70 leading-none text-[11px]">{conflicts.identicalSkipped}</div>
                            <div className="text-muted-foreground/70 mt-1 leading-none text-[10px]">{t('identical')}</div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs max-w-xs">
                          {t('identicalTooltip')}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {((conflicts.additiveSkipped ?? 0) + (conflicts.pzAdditiveSkipped ?? 0)) > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="text-center cursor-help opacity-70">
                            <div className="tabular-nums font-medium text-success/70 leading-none text-[11px]">{(conflicts.additiveSkipped ?? 0) + (conflicts.pzAdditiveSkipped ?? 0)}</div>
                            <div className="text-muted-foreground/70 mt-1 leading-none text-[10px]">{t('additive')}</div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs space-y-0.5">
                          <p className="font-medium mb-1">{t('additiveTooltipTitle')}</p>
                          {(conflicts.pzAdditiveBreakdown?.sandbox ?? 0) > 0 && <p>{t('additiveSandbox', { count: conflicts.pzAdditiveBreakdown!.sandbox })}</p>}
                          {(conflicts.pzAdditiveBreakdown?.translate ?? 0) + (conflicts.additiveSkipped ?? 0) > 0 && <p>{t('additiveTranslation', { count: (conflicts.pzAdditiveBreakdown?.translate ?? 0) + (conflicts.additiveSkipped ?? 0) })}</p>}
                          {(conflicts.pzAdditiveBreakdown?.scripts ?? 0) > 0 && <p>{t('additiveScripts', { count: conflicts.pzAdditiveBreakdown!.scripts })}</p>}
                          {(conflicts.pzAdditiveBreakdown?.clothing ?? 0) > 0 && <p>{t('additiveClothing', { count: conflicts.pzAdditiveBreakdown!.clothing })}</p>}
                          {(conflicts.pzAdditiveBreakdown?.fileguidtable ?? 0) > 0 && <p>{t('additiveMetadata', { count: conflicts.pzAdditiveBreakdown!.fileguidtable })}</p>}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {(conflicts.warnings?.length ?? 0) > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="text-center cursor-help">
                            <div className="tabular-nums font-semibold text-warning leading-none">{conflicts.warnings!.length}</div>
                            <div className="text-warning/70 mt-1 leading-none">{t('warningsCount', { count: conflicts.warnings!.length })}</div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs text-xs space-y-0.5">
                          {conflicts.warnings!.slice(0, 5).map((w, i) => <p key={i} className="break-words">{w}</p>)}
                          {conflicts.warnings!.length > 5 && <p className="text-muted-foreground">{t('moreCount', { count: conflicts.warnings!.length - 5 })}</p>}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-2">
                  <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {t('noModsConfigured')}
                </p>
              </div>
            )
            )
            })()}

            {conflicts.modsScanned > 0 && conflicts.totalConflicts === 0 && dedupedDepCount === 0 && (
              <div className="flex items-center justify-center py-8 text-muted-foreground scan-complete-flash">
                <div className="text-center max-w-xs">
                  <CheckCircle className="w-8 h-8 mx-auto text-success/70 mb-2" aria-hidden="true" />
                  <p className="font-medium text-foreground text-sm">{t('noConflictsFound')}</p>
                  <p className="text-xs mt-1 text-muted-foreground">
                    {t('modsScannedNoOverlap', { count: conflicts.modsScanned })}
                    {(conflicts.modsNotFound ?? 0) > 0 && (
                      <span className="block mt-0.5">
                        {t('modsNotDownloadedSkipped', { count: conflicts.modsNotFound })}
                      </span>
                    )}
                    {(conflicts.identicalSkipped ?? 0) > 0 && (
                      <span className="block mt-0.5">
                        {t('identicalFilesShared', { count: conflicts.identicalSkipped })}
                      </span>
                    )}
                    {(conflicts.additiveSkipped ?? 0) + (conflicts.pzAdditiveSkipped ?? 0) > 0 && (
                      <span className="block mt-0.5">
                        {t('filesAutoMerged', { count: (conflicts.additiveSkipped ?? 0) + (conflicts.pzAdditiveSkipped ?? 0) })}
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
                    {t('fileConflictsTab')}
                    {conflicts.totalPairs > 0 && (
                      <Badge variant="secondary" className="text-[11px] h-4 px-1 ms-0.5">{conflicts.totalPairs}</Badge>
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
                    {t('missingDepsTab')}
                    {dedupedDepCount > 0 && (
                      <Badge variant="destructive" className="text-[11px] h-4 px-1 ms-0.5">{dedupedDepCount}</Badge>
                    )}
                  </button>
                </div>

                {conflictSubTab === 'network' && (
                  <div className="space-y-3">

                    {(conflicts.pairs?.length ?? 0) > 0 && (() => {
                      const allPairKeys = filteredPairs.map(p => `${p.modA.modId}--${p.modB.modId}`)
                      const allExpanded = openPairs.length === allPairKeys.length && allPairKeys.length > 0
                      const sevFilteredTopMods = topConflictingMods
                        .map(m => {
                          if (pairSeverityFilter === 'high') return { ...m, medium: 0, low: 0 }
                          if (pairSeverityFilter === 'medium') return { ...m, high: 0, low: 0 }
                          if (pairSeverityFilter === 'low') return { ...m, high: 0, medium: 0 }
                          if (pairSeverityFilter === 'real') return { ...m, low: 0 }
                          return m
                        })
                        .filter(m => (m.high + m.medium + m.low) > 0)
                      const visibleTopMods = showAllTopMods ? sevFilteredTopMods : sevFilteredTopMods.slice(0, 6)
                      const hiddenTopCount = sevFilteredTopMods.length - visibleTopMods.length
                      return (
                        <>
                          <div className="rounded-lg border border-border/35 bg-card/35 px-3 py-2.5 space-y-2">
                          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                            <div className="flex flex-wrap items-center gap-1">
                              {[
                                { key: 'real' as const, label: t('severityReal'), count: severityCounts.real, dot: 'bg-warning', color: 'text-warning' },
                                { key: 'high' as const, label: t('severityCritical'), count: severityCounts.high, dot: 'bg-destructive', color: 'text-destructive' },
                                { key: 'medium' as const, label: t('severityMedium'), count: severityCounts.medium, dot: 'bg-warning', color: 'text-warning' },
                                { key: 'low' as const, label: t('severityLow'), count: severityCounts.low, dot: 'bg-primary/60', color: 'text-primary/70' },
                                { key: 'all' as const, label: t('severityAll'), count: severityCounts.all, dot: null },
                              ].map(tab => (
                                <button
                                  key={tab.key}
                                  onClick={() => setPairSeverityFilter(tab.key)}
                                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                    pairSeverityFilter === tab.key
                                      ? 'bg-accent text-accent-foreground'
                                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                                  }`}
                                  title={tab.key === 'real' ? t('severityRealTitle') : tab.key === 'all' ? t('severityAllTitle') : undefined}
                                >
                                  {tab.dot && <span className={`w-1.5 h-1.5 rounded-full ${tab.dot}`} aria-hidden="true" />}
                                  {tab.label}
                                  <span className={`tabular-nums ${pairSeverityFilter === tab.key ? '' : tab.color || ''}`}>{tab.count}</span>
                                </button>
                              ))}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="relative">
                                <Search className="w-3 h-3 absolute start-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" aria-hidden="true" />
                                <input
                                  type="text"
                                  value={pairSearchQuery}
                                  onChange={(e) => setPairSearchQuery(e.target.value)}
                                  placeholder={t('filterByModName')}
                                  aria-label={t('filterConflictPairsAria')}
                                  className="h-8 w-full min-w-[14rem] ps-6 pe-6 rounded-md text-[11px] bg-background/50 border border-border/40 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent placeholder:text-muted-foreground/50 sm:w-56"
                                />
                                {pairSearchQuery && (
                                  <button
                                    type="button"
                                    onClick={() => setPairSearchQuery('')}
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground text-[10px] leading-none"
                                    aria-label={t('clearFilter')}
                                    title={t('clearFilter')}
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
                                  {t('clearModFilter')}
                                </button>
                              )}
                            </div>
                          </div>

                          <details className="group/conflict-tools rounded border border-border/25 bg-muted/15 px-2 py-1.5">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] text-muted-foreground hover:text-foreground">
                              <span className="inline-flex items-center gap-1.5">
                                <ChevronRight className="h-3 w-3 transition-transform group-open/conflict-tools:rotate-90" aria-hidden="true" />
                                {t('triageControls')}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground/65">
                                {groupByWinner ? t('grouped') : t('flat')} · {t('openCount', { count: openPairs.length })}
                              </span>
                            </summary>
                            <div className="mt-2 space-y-2 border-t border-border/25 pt-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setGroupByWinner(v => !v)}
                                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
                                    groupByWinner
                                      ? 'border-accent/40 bg-accent/10 text-accent-foreground'
                                      : 'border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/20'
                                  }`}
                                  title={t('groupByWinnerTitle')}
                                >
                                  <Layers className="w-3 h-3" aria-hidden="true" />
                                  {t('groupByWinner')}
                                </button>
                                <button
                                  type="button"
                                  className="rounded border border-border/40 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors"
                                  onClick={() => setOpenPairs(allExpanded ? [] : allPairKeys)}
                                >
                                  {allExpanded ? t('collapseAllPairs') : t('expandAllPairs')}
                                </button>
                                <button
                                  type="button"
                                  className="rounded border border-border/40 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors"
                                  onClick={() => setShowAllTopMods(v => !v)}
                                  disabled={hiddenTopCount <= 0 && !showAllTopMods}
                                >
                                  {showAllTopMods ? t('showFewerTopMods') : t('showMoreTopMods', { count: Math.max(hiddenTopCount, 0) })}
                                </button>
                              </div>
                              {sevFilteredTopMods.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {visibleTopMods.map((mod) => {
                                    const isSelected = graphFilterMod === mod.modId
                                    const total = mod.high + mod.medium + mod.low
                                    return (
                                      <button
                                        key={mod.modId}
                                        onClick={() => setGraphFilterMod(isSelected ? null : mod.modId)}
                                        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                                          isSelected
                                            ? 'bg-accent/15 border-accent/40 text-accent-foreground'
                                            : 'bg-muted/5 border-border/30 text-foreground/70 hover:bg-muted/20 hover:border-border/50'
                                        }`}
                                        title={t('topModTitle', { name: mod.modName, total, high: mod.high, medium: mod.medium, low: mod.low, pairs: mod.pairs })}
                                      >
                                        <span className="max-w-[150px] truncate">{mod.modName}</span>
                                        <span className="shrink-0 font-mono tabular-nums text-[10px] text-muted-foreground/80">{total}</span>
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
                                  : [{ key: '__flat__', name: '', modId: null, pairs: filteredPairs }]
                                ).map((__group) => (
                                  <div key={__group.key}>
                                    {groupByWinner && groupedPairs.length > 1 && (
                                      <div className="px-2 pt-1 pb-1.5 flex items-baseline gap-2 text-[11px]">
                                        <CheckCircle className="w-3 h-3 text-success/70 self-center shrink-0" aria-hidden="true" />
                                        <span className={`font-semibold truncate ${__group.key.startsWith('__') ? 'text-muted-foreground' : 'text-foreground/85'}`} title={__group.name}>
                                          {__group.name || t('pairsFallbackName')}
                                        </span>
                                        <span className="text-muted-foreground/70 shrink-0">
                                          {t('winsNPairs', { count: __group.pairs.length })}
                                        </span>
                                      </div>
                                    )}
                                    <Accordion type="multiple" value={openPairs} onValueChange={setOpenPairs} className="space-y-1.5">
                                      {__group.pairs.map((pair, pairIdx) => {
                                  const pairKey = `${pair.modA.modId}--${pair.modB.modId}`
                                  const totalFiles = pair.files.length
                                  const showAll = expandedFilePairs.has(pairKey)
                                  const visibleFiles = showAll ? pair.files : pair.files.slice(0, CONFLICT_FILE_LIMIT)
                                  const hiddenCount = showAll ? 0 : totalFiles - Math.min(totalFiles, CONFLICT_FILE_LIMIT)
                                  const maxSeverity = pair.highCount > 0 ? 'high' : pair.mediumCount > 0 ? 'medium' : 'low'
                                  const posA = loadOrderMap.get(pair.modA.modId)
                                  const posB = loadOrderMap.get(pair.modB.modId)
                                  const winner = posA != null && posB != null ? (posA > posB ? 'A' : posB > posA ? 'B' : null) : null
                                  return (
                                    <AccordionItem key={pairKey} value={pairKey} className={`border rounded-lg px-0 overflow-hidden border-s-[3px] conflict-pair-enter ${
                                      maxSeverity === 'high' ? 'border-s-destructive/60 bg-destructive/[0.02]' : maxSeverity === 'medium' ? 'border-s-warning/50' : 'border-s-primary/40'
                                    }`} style={{ animationDelay: `${Math.min(pairIdx * 50, 400)}ms` }}>
                                      <AccordionTrigger className="px-3 py-2.5 hover:no-underline hover:bg-muted/20 [&[data-state=open]]:bg-muted/15 transition-colors">
                                        <div className="flex min-w-0 flex-1 flex-col gap-2 text-start sm:flex-row sm:items-center sm:gap-3">
                                          <div className={`w-2 h-2 rounded-full shrink-0 ${
                                            maxSeverity === 'high' ? 'bg-destructive severity-pulse' : maxSeverity === 'medium' ? 'bg-warning' : 'bg-primary/60'
                                          }`} aria-hidden="true" />
                                          <span className="sr-only">{maxSeverity} severity conflict:</span>

                                          {(() => {
                                            const aw = pair.aWins ?? 0
                                            const bw = pair.bWins ?? 0
                                            const tp = pair.thirdPartyWins ?? 0
                                            const uk = pair.unknownWins ?? 0
                                            const aWinsAll = aw > 0 && bw === 0 && tp === 0 && uk === 0
                                            const bWinsAll = bw > 0 && aw === 0 && tp === 0 && uk === 0
                                            const tpWinsAll = tp > 0 && aw === 0 && bw === 0
                                            const thirdPartyName = tp > 0
                                              ? pair.files.find(f => f.winner && f.winner.modId !== pair.modA.modId && f.winner.modId !== pair.modB.modId)?.winner?.modName
                                              : null
                                            const fallbackWinnerSide = aw === 0 && bw === 0 && tp === 0 && uk === 0 ? winner : null

                                            const modPill = (mod: typeof pair.modA, pos: number | undefined, isWinner: boolean, isLoser: boolean) => (
                                              <div className={`flex flex-col min-w-0 max-w-[44%] flex-1 px-2 py-1 rounded transition-colors ${
                                                isWinner ? 'bg-success/10 border border-success/25' : isLoser ? 'opacity-60' : ''
                                              }`} title={pos != null ? t('loadOrderTitle', { name: mod.modName, pos }) : mod.modName}>
                                                <span className={`truncate text-sm font-medium leading-tight ${isLoser ? 'line-through decoration-muted-foreground/40' : 'text-foreground/90'}`}>
                                                  {mod.modName}
                                                </span>
                                                {isWinner && (
                                                  <span className="text-[10px] leading-none mt-0.5 text-success/80">
                                                    {t('loadsLater')}
                                                  </span>
                                                )}
                                              </div>
                                            )

                                            return (
                                              <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                                                {modPill(pair.modA, posA, aWinsAll || fallbackWinnerSide === 'A', bWinsAll || fallbackWinnerSide === 'B')}
                                                <ArrowRight className={`w-3.5 h-3.5 shrink-0 ${
                                                  aWinsAll || fallbackWinnerSide === 'A' ? 'text-success/60 -scale-x-100' : bWinsAll || fallbackWinnerSide === 'B' ? 'text-success/60' : 'text-muted-foreground/40'
                                                } hidden sm:block`} aria-hidden="true" />
                                                {modPill(pair.modB, posB, bWinsAll || fallbackWinnerSide === 'B', aWinsAll || fallbackWinnerSide === 'A')}

                                                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ms-auto sm:flex-nowrap">
                                                  <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/30 border border-border/30">
                                                    <span className="text-[11px] tabular-nums font-medium text-foreground/80">
                                                      {totalFiles}
                                                    </span>
                                                    <span className="text-[10px] text-muted-foreground/70">{t('filesWord', { count: totalFiles })}</span>
                                                    {(pair.highCount > 0 || pair.mediumCount > 0 || pair.lowCount > 0) && (
                                                      <span className="flex items-center gap-0.5 ms-1 ps-1.5 border-s border-border/40">
                                                        {pair.highCount > 0 && (
                                                          <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-destructive/80">
                                                            <span className="w-1 h-1 rounded-full bg-destructive" aria-hidden="true" />
                                                            {pair.highCount}
                                                          </span>
                                                        )}
                                                        {pair.mediumCount > 0 && (
                                                          <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-warning/80">
                                                            <span className="w-1 h-1 rounded-full bg-warning" aria-hidden="true" />
                                                            {pair.mediumCount}
                                                          </span>
                                                        )}
                                                        {pair.lowCount > 0 && (
                                                          <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-primary/70">
                                                            <span className="w-1 h-1 rounded-full bg-primary/60" aria-hidden="true" />
                                                            {pair.lowCount}
                                                          </span>
                                                        )}
                                                      </span>
                                                    )}
                                                  </div>

                                                  {tpWinsAll ? (
                                                    <Tooltip>
                                                      <TooltipTrigger asChild>
                                                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-muted-foreground/20 text-muted-foreground cursor-help">
                                                          {thirdPartyName ? t('namedModWins', { name: thirdPartyName }) : t('thirdModWins')}
                                                        </span>
                                                      </TooltipTrigger>
                                                      <TooltipContent side="left" className="text-xs max-w-xs">
                                                        {t('thirdModWinsTooltip', { modA: pair.modA.modName, modB: pair.modB.modName })}
                                                      </TooltipContent>
                                                    </Tooltip>
                                                  ) : aWinsAll || bWinsAll ? (
                                                    (pair.highCount > 0 || pair.mediumCount > 0) ? (
                                                      <Tooltip>
                                                        <TooltipTrigger asChild>
                                                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-warning/30 bg-warning/10 text-warning cursor-help">
                                                            <FileWarning className="w-3 h-3" aria-hidden="true" />
                                                            {t('decided')}
                                                          </span>
                                                        </TooltipTrigger>
                                                        <TooltipContent side="left" className="text-xs max-w-xs">
                                                          {t('decidedTooltip', { count: totalFiles })}
                                                        </TooltipContent>
                                                      </Tooltip>
                                                    ) : (
                                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-success/30 bg-success/10 text-success">
                                                        <CheckCircle className="w-3 h-3" aria-hidden="true" />
                                                        {t('clean')}
                                                      </span>
                                                    )
                                                  ) : (aw > 0 || bw > 0 || tp > 0 || uk > 0) ? (
                                                    <Tooltip>
                                                      <TooltipTrigger asChild>
                                                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-warning/30 bg-warning/10 text-warning cursor-help tabular-nums">
                                                          {t('mixedCounts', { aw, bw, tp: tp > 0 ? `+${tp}` : '', uk: uk > 0 ? `?${uk}` : '' })}
                                                        </span>
                                                      </TooltipTrigger>
                                                      <TooltipContent side="left" className="text-xs max-w-xs">
                                                        {t('mixedWinsBase', { modA: pair.modA.modName, count: aw, modB: pair.modB.modName, bw })}
                                                        {tp > 0 && ` ${t('mixedThirdMod', { count: tp })}`}
                                                        {uk > 0 && ` ${t('mixedUndetermined', { count: uk })}`}
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
                                              <Badge variant="destructive" className="text-[11px] leading-none h-[18px] px-1.5">{t('severityHighBadge', { count: pair.highCount })}</Badge>
                                            )}
                                            {pair.mediumCount > 0 && (
                                              <Badge variant="warning" className="text-[11px] leading-none h-[18px] px-1.5">{t('severityMediumBadge', { count: pair.mediumCount })}</Badge>
                                            )}
                                            {pair.lowCount > 0 && (
                                              <Badge variant="secondary" className="text-[11px] leading-none h-[18px] px-1.5 border-primary/20 text-primary">{t('severityLowBadge', { count: pair.lowCount })}</Badge>
                                            )}
                                            <span className="text-[11px] text-muted-foreground/70">{t('shownCount', { count: visibleFiles.length })}{hiddenCount > 0 ? ` · ${t('hiddenCount', { count: hiddenCount })}` : ''}</span>

                                            {posA != null && posB != null && (
                                              <div className="ms-auto flex items-center gap-1.5 flex-wrap">
                                                <DisabledReason reason={posA > posB ? t('alreadyLoadsLast', { name: pair.modA.modName }) : null}>
                                                  <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-7 px-2 text-[11px] gap-1"
                                                    disabled={savingModOrder || posA > posB}
                                                    // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27: the disabled-reason branch (posA > posB, "already loads last") now lives in the DisabledReason wrapper above; this title carries only the enabled-state action hint.
                                                    title={posA > posB ? undefined : t('moveToLoadAfter', { name: pair.modA.modName, other: pair.modB.modName })}
                                                    onClick={(e) => {
                                                      e.stopPropagation()
                                                      promoteModOverOpponent(pair.modA.modId, pair.modA.modName, pair.modB.modId, pair.modB.modName)
                                                    }}
                                                  >
                                                    <Wrench className="w-3 h-3" />
                                                    <span className="truncate max-w-[140px]">{t('makeAWin')}</span>
                                                  </Button>
                                                </DisabledReason>
                                                <DisabledReason reason={posB > posA ? t('alreadyLoadsLast', { name: pair.modB.modName }) : null}>
                                                  <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-7 px-2 text-[11px] gap-1"
                                                    disabled={savingModOrder || posB > posA}
                                                    // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27: the disabled-reason branch (posB > posA, "already loads last") now lives in the DisabledReason wrapper above; this title carries only the enabled-state action hint.
                                                    title={posB > posA ? undefined : t('moveToLoadAfter', { name: pair.modB.modName, other: pair.modA.modName })}
                                                    onClick={(e) => {
                                                      e.stopPropagation()
                                                      promoteModOverOpponent(pair.modB.modId, pair.modB.modName, pair.modA.modId, pair.modA.modName)
                                                    }}
                                                  >
                                                    <Wrench className="w-3 h-3" />
                                                    <span className="truncate max-w-[140px]">{t('makeBWin')}</span>
                                                  </Button>
                                                </DisabledReason>
                                                <Button
                                                  size="sm"
                                                  variant="ghost"
                                                  className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                                                  title={t('seeEveryConflictInvolving', { name: pair.modA.modName })}
                                                  onClick={(e) => { e.stopPropagation(); setModDetailsId(pair.modA.modId) }}
                                                >
                                                  <Info className="w-3 h-3" /> {t('detailsA')}
                                                </Button>
                                                <Button
                                                  size="sm"
                                                  variant="ghost"
                                                  className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                                                  title={t('seeEveryConflictInvolving', { name: pair.modB.modName })}
                                                  onClick={(e) => { e.stopPropagation(); setModDetailsId(pair.modB.modId) }}
                                                >
                                                  <Info className="w-3 h-3" /> {t('detailsB')}
                                                </Button>
                                              </div>
                                            )}
                                          </div>
                                          {visibleFiles.map((f) => {
                                            const winnerName = f.winner?.modId === pair.modA.modId
                                              ? pair.modA.modName
                                              : f.winner?.modId === pair.modB.modId
                                              ? pair.modB.modName
                                              : null
                                            const loserName = winnerName == null
                                              ? null
                                              : winnerName === pair.modA.modName
                                              ? pair.modB.modName
                                              : pair.modA.modName
                                            return (
                                              <FileDiffViewer
                                                key={`${pair.modA.modId}--${pair.modB.modId}--${f.file}`}
                                                file={f.file}
                                                modAId={pair.modA.modId}
                                                modBId={pair.modB.modId}
                                                modAName={pair.modA.modName}
                                                modBName={pair.modB.modName}
                                                severity={f.severity}
                                                categoryLabel={f.categoryLabel}
                                                winnerName={winnerName}
                                                loserName={loserName}
                                                overlap={f.overlap}
                                              />
                                            )
                                          })}
                                          {hiddenCount > 0 && (
                                            <button
                                              onClick={() => setExpandedFilePairs(prev => {
                                                const next = new Set(prev)
                                                next.add(pairKey)
                                                return next
                                              })}
                                              className="text-[11px] text-muted-foreground/70 hover:text-foreground text-center pt-2 w-full transition-colors"
                                            >
                                              {t('showMoreFiles', { count: hiddenCount })}
                                            </button>
                                          )}
                                        </div>
                                      </AccordionContent>
                                    </AccordionItem>
                                  )
                                })}
                                    </Accordion>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="text-center py-4 text-xs text-muted-foreground">
                              {t('noPairsMatchFilter')}
                            </div>
                          )}
                        </>
                      )
                    })()}



                  </div>
                )}

                {conflictSubTab === 'dependencies' && (() => {
                  const rows = depRows
                  const missingRaw = conflicts?.missingDeps || []
                  const steamRaw = conflicts?.steamDeps || []

                  if (missingRaw.length === 0 && steamRaw.length === 0) {
                    return (
                      <div className="flex items-center justify-center py-10 text-muted-foreground">
                        <div className="text-center max-w-xs">
                          <CheckCircle className="w-8 h-8 mx-auto text-success/70 mb-2" aria-hidden="true" />
                          <p className="font-medium text-foreground text-sm">{t('allDepsSatisfied')}</p>
                          <p className="text-xs mt-1 text-muted-foreground">{t('allDepsSatisfiedDesc')}</p>
                        </div>
                      </div>
                    );
                  }

                  const handleAddDep = async (workshopId: string, modId: string, key: string) => {
                    if (busyRef.current) return
                    busyRef.current = true
                    setDepAdding(prev => [...prev, key]);
                    try {
                      const result = await modsApi.addMissingDep(workshopId, modId);
                      setDepAddResults(prev => ({ ...prev, [key]: result.modId !== null ? 'added' as const : 'error' as const }));
                    } catch {
                      setDepAddResults(prev => ({ ...prev, [key]: 'error' as const }));
                    } finally {
                      setDepAdding(prev => prev.filter(k => k !== key));
                      busyRef.current = false
                    }
                  };

                  const handleUndoDep = async (workshopId: string, key: string) => {
                    if (busyRef.current) return
                    busyRef.current = true
                    setDepAdding(prev => [...prev, key]);
                    try {
                      await modsApi.batchRemove([workshopId]);
                      setDepAddResults(prev => {
                        const next = { ...prev }
                        delete next[key]
                        return next
                      });
                      fetchData();
                      toast({ title: t('removedToastTitle'), description: t('dependencyUnadded') });
                    } catch (err) {
                      toast({
                        title: t('undoFailedTitle'),
                        description: getUserErrorMessage(err, t('couldNotRemoveMod')),
                        variant: 'destructive',
                      });
                    } finally {
                      setDepAdding(prev => prev.filter(k => k !== key));
                      busyRef.current = false
                    }
                  };

                  const runDepSearch = async (row: typeof rows[number], force = false) => {
                    const key = row.key
                    if (!force && depSearchData[key] && !depSearchData[key].error) return
                    setDepSearchData(prev => ({ ...prev, [key]: { loading: true, results: [], error: null, searchUrl: null } }))
                    try {
                      const res = await modsApi.searchWorkshopMods(row.depModId || row.depName, {
                        parentName: row.requiredBy,
                        parentWorkshopId: row.requiredByWsId,
                      })
                      setDepSearchData(prev => ({ ...prev, [key]: { loading: false, results: res.results || [], error: null, searchUrl: res.searchUrl, variantsTried: res.variantsTried, steamSearchEnabled: res.steamSearchEnabled } }))
                    } catch (err: any) {
                      setDepSearchData(prev => ({ ...prev, [key]: { loading: false, results: [], error: getUserErrorMessage(err, t('searchFailed')), searchUrl: null } }))
                    }
                  }
                  const toggleDepSearch = (row: typeof rows[number]) => {
                    const key = row.key
                    setDepSearchOpen(prev => {
                      const next = new Set(prev)
                      if (next.has(key)) { next.delete(key); return next }
                      next.add(key); return next
                    })
                    if (!depSearchData[key]) runDepSearch(row)
                  }

                  const addableRows = rows.filter(r => r.depWorkshopId && depAddResults[r.key] !== 'added')
                  const addedCount = rows.filter(r => depAddResults[r.key] === 'added').length

                  const handleFixAll = async () => {
                    if (addableRows.length === 0 || fixingAllDeps || busyRef.current) return
                    busyRef.current = true
                    setFixingAllDeps(true)
                    try {
                      const response = await modsApi.addAllResolvedDeps(
                        addableRows.map(r => ({ workshopId: r.depWorkshopId!, modId: r.depModId || undefined }))
                      )
                      const resultByWorkshopId = new Map(
                        (response.results || []).map(r => [r.workshopId, r])
                      )
                      setDepAddResults(prev => {
                        const next = { ...prev }
                        for (const r of addableRows) {
                          const result = r.depWorkshopId ? resultByWorkshopId.get(r.depWorkshopId) : undefined
                          next[r.key] = result && result.modId !== null ? 'added' as const : 'error' as const
                        }
                        return next
                      })
                    } catch (err) {
                      reportClientError('Failed to add all dependencies.', err)
                      for (const r of addableRows) {
                        setDepAddResults(prev => ({ ...prev, [r.key]: 'error' as const }))
                      }
                    }
                    finally { setFixingAllDeps(false); busyRef.current = false }
                  }

                  return (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          {t('missingCount', { count: rows.length })}
                          {addableRows.length < rows.length - addedCount && (
                            <span className="ms-1 text-warning/80">— {t('unresolvedCount', { count: rows.length - addableRows.length - addedCount })}</span>
                          )}
                          {addedCount > 0 && <span className="text-success ms-1">{t('addedCountParen', { count: addedCount })}</span>}
                        </span>
                        {addableRows.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleFixAll}
                            disabled={fixingAllDeps}
                            className="h-7 text-xs"
                            // eslint-disable-next-line local/no-dead-disabled-title -- pure hint: the ternary's condition (addableRows vs rows count) is unrelated to the disabled condition (fixingAllDeps, a transient in-flight state shown by the spinner). Neither branch explains the disable. Triaged 2026-08-27.
                            title={addableRows.length < rows.length - addedCount
                              ? t('addResolvedPartialTitle', { count: addableRows.length, remaining: rows.length - addableRows.length - addedCount })
                              : t('addResolvedAllTitle', { count: addableRows.length })}
                          >
                            {fixingAllDeps ? <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" /> : <PlusCircle className="w-3.5 h-3.5 me-1.5" />}
                            {t('addResolvedButton', { count: addableRows.length })}
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
                            <div key={row.key} className={`transition-colors ${added ? 'bg-success/5' : 'bg-background/30 hover:bg-muted/10'}`}>
                              <div className="flex items-center gap-3 px-4 py-2.5">
                              <span className={`w-2 h-2 rounded-full shrink-0 ${
                                added ? 'bg-success' : row.depWorkshopId ? 'bg-warning' : 'bg-destructive'
                              }`} />

                              <div className="flex-1 min-w-0">
                                <span className={`text-sm font-medium block truncate ${added ? 'text-success/80 line-through' : 'text-foreground/90'}`}>
                                  {row.depName}
                                </span>
                <span className="text-[11px] text-muted-foreground block truncate">
                                  {t('requiredBy')}{' '}
                                  <a href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${row.requiredByWsId}`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="text-muted-foreground/70 hover:text-foreground underline decoration-muted-foreground/30 hover:decoration-foreground/50 transition-colors"
                                  >{row.requiredBy}<span className="sr-only"> {t('opensInNewTab')}</span></a>
                                  {row.source === 'steam' && <span className="ms-1.5 text-accent/70">{t('viaWorkshop')}</span>}
                                </span>
                              </div>

                              <div className="shrink-0 flex items-center gap-1.5">
                                {added ? (
                                  <>
                                    <span className="text-xs text-success flex items-center gap-1"><Check className="w-3.5 h-3.5" /> {t('added')}</span>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="iconDense"
                                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                          onClick={() => row.depWorkshopId && handleUndoDep(row.depWorkshopId, row.key)}
                                          disabled={adding || !row.depWorkshopId}
                                          aria-label={t('undoRemoveAria', { name: row.depName })}
                                        >
                                          {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('undoRemoveFromServer')}</TooltipContent>
                                    </Tooltip>
                                  </>
                                ) : errored ? (
                                  <span className="text-xs text-destructive">{t('failed')}</span>
                                ) : row.depWorkshopId ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleAddDep(row.depWorkshopId!, row.depModId || '', row.key)}
                                    disabled={adding}
                                    className="h-7 px-2.5 text-xs"
                                  >
                                    {adding ? <Loader2 className="w-3 h-3 animate-spin me-1" /> : <Plus className="w-3 h-3 me-1" />}
                                    {t('add')}
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
                                    <Search className="w-3 h-3 me-1" /> {searchOpen ? t('hide') : t('searchWorkshop')}
                                  </Button>
                                )}
                                {row.depWorkshopId && (
                                  <a href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${row.depWorkshopId}`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1"
                                    title={t('viewOnSteamWorkshop')}
                                    aria-label={t('viewOnSteamWorkshopAria')}>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                              </div>
                              </div>

                              {searchOpen && !row.depWorkshopId && !added && (
                                <div id={`dep-search-${row.key}`} className="border-t border-border/20 bg-muted/20 px-4 py-3">
                                  {searchState?.loading ? (
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('searchingWorkshopFor', { query: row.depModId || row.depName })}
                                    </div>
                                  ) : searchState?.error ? (
                                    <div className="flex items-center justify-between gap-2 text-xs">
                                      <span className="text-destructive break-words">{t('searchFailedWithError', { error: searchState.error })}</span>
                                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => runDepSearch(row, true)}>{t('retry')}</Button>
                                    </div>
                                  ) : searchState && searchState.results.length === 0 ? (
                                    <div className="space-y-2 text-xs">
                                      {searchState.steamSearchEnabled === false ? (
                                        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-warning">
                                          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                                          <span>
                                            <Trans i18nKey="workshopSearchDisabled" t={t} components={{ 1: <strong /> }} />
                                          </span>
                                        </div>
                                      ) : (
                                        <p className="text-muted-foreground">
                                          {t('noMatchesFoundWorkshop')} {searchState.variantsTried && searchState.variantsTried.length > 1 && (
                                            <span className="text-muted-foreground/70">{t('triedVariants', { list: searchState.variantsTried.slice(0, 4).join(', ') })}</span>
                                          )}
                                        </p>
                                      )}
                                      {searchState.searchUrl && (
                                        <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent/80 hover:text-accent">
                                          <ExternalLink className="w-3 h-3" /> {t('openWorkshopSearchBrowser')}
                                        </a>
                                      )}
                                    </div>
                                  ) : searchState && searchState.results.length > 0 ? (
                                    <div className="space-y-2">
                                      <p className="text-[11px] text-muted-foreground">
                                        {t('possibleMatchesHint', { count: searchState.results.length })}
                                      </p>
                                      {searchState.steamSearchEnabled === false && (
                                        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning">
                                          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                                          <span>
                                            {t('onlyLocalModsSearched')}
                                          </span>
                                        </div>
                                      )}
                                      <ul className="space-y-1.5 max-h-72 overflow-y-auto pe-1">
                                        {searchState.results.map((hit) => {
                                          const candidateKey = `${row.key}::${hit.workshopId}`
                                          const candAdding = depAdding.includes(candidateKey)
                                          const candAdded = depAddResults[candidateKey] === 'added'
                                          const candErrored = depAddResults[candidateKey] === 'error'
                                          return (
                                            <li key={hit.workshopId} className="flex items-start gap-2 rounded-md border border-border/30 bg-background/50 px-2.5 py-2">
                                              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${hit.isDownloaded ? 'bg-success' : 'bg-accent/60'}`} aria-hidden="true" />
                                              <div className="flex-1 min-w-0">
                                                <div className="flex items-baseline gap-2 flex-wrap">
                                                  <a
                                                    href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${hit.workshopId}`}
                                                    target="_blank" rel="noopener noreferrer"
                                                    className="text-sm font-medium text-foreground/90 hover:text-foreground truncate"
                                                  >{hit.modName}</a>
                                                  {hit.modId && (
                                                    <code className="text-[10px] text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">{hit.modId}</code>
                                                  )}
                                                  {hit.isDownloaded && <span className="text-[10px] text-success">{t('downloaded')}</span>}
                                                  {typeof hit.subscriberCount === 'number' && hit.subscriberCount > 0 && (
                                                    <span className="text-[10px] text-muted-foreground/70">{t('subsCount', { count: hit.subscriberCount, formatted: hit.subscriberCount.toLocaleString(i18n.language) })}</span>
                                                  )}
                                                </div>
                                                {hit.description && (
                                                  <p className="text-[11px] text-muted-foreground/80 line-clamp-2 mt-0.5">{hit.description}</p>
                                                )}
                                              </div>
                                              <div className="shrink-0">
                                                {candAdded ? (
                                                  <span className="text-xs text-success flex items-center gap-1"><Check className="w-3.5 h-3.5" /> {t('added')}</span>
                                                ) : candErrored ? (
                                                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => handleAddDep(hit.workshopId, hit.modId || row.depModId || '', candidateKey)}>{t('retry')}</Button>
                                                ) : (
                                                  <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-7 px-2.5 text-xs"
                                                    disabled={candAdding}
                                                    onClick={() => handleAddDep(hit.workshopId, hit.modId || row.depModId || '', candidateKey)}
                                                  >
                                                    {candAdding ? <Loader2 className="w-3 h-3 animate-spin me-1" /> : <Plus className="w-3 h-3 me-1" />}
                                                    {t('add')}
                                                  </Button>
                                                )}
                                              </div>
                                            </li>
                                          )
                                        })}
                                      </ul>
                                      {searchState.searchUrl && (
                                        <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors">
                                          <ExternalLink className="w-3 h-3" /> {t('notHereOpenBrowser')}
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
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>

    <Dialog open={modDetailsId != null} onOpenChange={(open) => { if (!open) setModDetailsId(null) }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto sm:max-h-[80vh]">
        {(() => {
          if (!modDetailsId || !conflicts) return null
          const allPairs = conflicts.pairs ?? []
          const myPairs = allPairs.filter(p => p.modA.modId === modDetailsId || p.modB.modId === modDetailsId)
          if (myPairs.length === 0) {
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{t('noConflictsTitle')}</DialogTitle>
                  <DialogDescription>{t('noConflictsRecordedDesc')}</DialogDescription>
                </DialogHeader>
              </>
            )
          }
          const firstHit = myPairs[0]
          const modName = firstHit.modA.modId === modDetailsId ? firstHit.modA.modName : firstHit.modB.modName
          const pos = loadOrderMap.get(modDetailsId)
          let winsPairs = 0, losesPairs = 0, tiedPairs = 0
          let totalFiles = 0
          const extCounts = new Map<string, number>()
          for (const p of myPairs) {
            totalFiles += p.files.length
            for (const f of p.files) {
              const dot = f.file.lastIndexOf('.')
              const ext = dot >= 0 ? f.file.slice(dot + 1).toLowerCase() : '(no ext)'
              extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1)
            }
            const myPos = loadOrderMap.get(modDetailsId)
            const otherId = p.modA.modId === modDetailsId ? p.modB.modId : p.modA.modId
            const otherPos = loadOrderMap.get(otherId)
            if (myPos != null && otherPos != null) {
              if (myPos > otherPos) winsPairs++
              else if (myPos < otherPos) losesPairs++
              else tiedPairs++
            }
          }
          const topExts = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)
          const sortedPairs = [...myPairs].sort((a, b) =>
            (b.highCount - a.highCount) || (b.mediumCount - a.mediumCount) || (b.files.length - a.files.length)
          )

          const jumpToPair = (pair: typeof myPairs[number]) => {
            const key = `${pair.modA.modId}--${pair.modB.modId}`
            setOpenPairs(prev => prev.includes(key) ? prev : [...prev, key])
            setModDetailsId(null)
            setTimeout(() => {
              const el = document.querySelector(`[data-state][value="${CSS.escape(key)}"]`) as HTMLElement | null
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
                    <span className="text-[11px] font-normal text-muted-foreground shrink-0">{t('loadHash', { pos })}</span>
                  )}
                </DialogTitle>
                <DialogDescription>
                  {t('pairsOverlappingFiles', { pairs: myPairs.length, files: totalFiles })}
                  {(winsPairs > 0 || losesPairs > 0 || tiedPairs > 0) && (
                    <> · {t('winsLosesTied', { wins: winsPairs, loses: losesPairs })}{tiedPairs > 0 ? ` · ${t('tiedCount', { count: tiedPairs })}` : ''}</>
                  )}
                </DialogDescription>
              </DialogHeader>

              {topExts.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap pb-1 border-b border-border/30">
                  <span className="text-[11px] text-muted-foreground">{t('topFileTypes')}</span>
                  {topExts.map(([ext, count]) => (
                    <Badge key={ext} variant="secondary" className="text-[10px] h-5 px-1.5 tabular-nums">
                      .{ext} <span className="text-muted-foreground/80 ms-1">{count}</span>
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
                  const winning = myPos != null && otherPos != null ? (myPos > otherPos ? 'win' : myPos < otherPos ? 'lose' : 'tie') : 'unknown'
                  const maxSev = p.highCount > 0 ? 'high' : p.mediumCount > 0 ? 'medium' : 'low'
                  return (
                    <li key={`${p.modA.modId}--${p.modB.modId}`}
                        className={`flex items-center gap-2 rounded-md border px-2.5 py-2 ${
                          maxSev === 'high' ? 'border-destructive/40 bg-destructive/[0.03]' :
                          maxSev === 'medium' ? 'border-warning/40 bg-warning/[0.03]' :
                          'border-border/40'
                        }`}>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                        maxSev === 'high' ? 'bg-destructive' : maxSev === 'medium' ? 'bg-warning' : 'bg-primary/60'
                      }`} aria-hidden="true" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{other.modName}</div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
                          <span className="tabular-nums">{t('filesCount', { count: p.files.length })}</span>
                          {p.highCount > 0 && <span className="text-destructive/80 tabular-nums">{t('highCountShort', { count: p.highCount })}</span>}
                          {p.mediumCount > 0 && <span className="text-warning/80 tabular-nums">{t('medCountShort', { count: p.mediumCount })}</span>}
                          {p.lowCount > 0 && <span className="text-primary/70 tabular-nums">{t('lowCountShort', { count: p.lowCount })}</span>}
                          {otherPos != null && <span>{t('loadHash', { pos: otherPos })}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {winning === 'win' && (
                          <Badge variant="secondary" className="text-[10px] h-5 px-1.5 border-success/30 bg-success/10 text-success">{t('wins')}</Badge>
                        )}
                        {winning === 'lose' && (
                          <Badge variant="secondary" className="text-[10px] h-5 px-1.5 border-warning/30 bg-warning/10 text-warning">{t('loses')}</Badge>
                        )}
                        {winning === 'lose' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px] gap-1"
                            disabled={savingModOrder}
                            onClick={() => promoteModOverOpponent(modDetailsId, modName, other.modId, other.modName)}
                          >
                            <Wrench className="w-3 h-3" /> {t('winIt')}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => jumpToPair(p)}
                        >
                          {t('view')}
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>

              <DialogFooter className="pt-2">
                <Button variant="outline" size="sm" onClick={() => setModDetailsId(null)}>{t('close')}</Button>
              </DialogFooter>
            </>
          )
        })()}
      </DialogContent>
    </Dialog>
  </div>
  )
}
