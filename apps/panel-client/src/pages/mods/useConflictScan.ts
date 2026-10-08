import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, modsApi } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'
import { createConflictScanSnapshot, recalculateConflictWinners } from '@/lib/conflictSeverity'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { apiUrl, getSelectedServerId } from '@/lib/serverSelection'
import { readSseStream } from '@/lib/sse'
import type { ConflictScanResult, ScanStreamConflictFound, ScanStreamModScanned } from '@/types'
import { notify } from './modsShared'
import type { ModsData } from './useModsData'

const IDLE_TIMEOUT_MS = 90_000

/**
 * The file-overlap scan behind Conflicts. It streams progress over SSE, falls back to the last
 * cached result when the stream drops, and keeps conflict winners in step with the load order.
 */
export function useConflictScan(data: ModsData) {
  const { iniConfig, orderedModIds, setOrderedModIds, busyRef, serverChangedSinceLoad, fetchData } = data
  const selectedServerId = getSelectedServerId()
  const [conflicts, setConflicts] = useState<ConflictScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastScanTime, setLastScanTime] = useState<Date | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [currentMod, setCurrentMod] = useState<string | null>(null)
  const [modsScanned, setModsScanned] = useState(0)
  const [totalMods, setTotalMods] = useState(0)
  const [streamConflicts, setStreamConflicts] = useState<ScanStreamConflictFound[]>([])
  const [savingOrder, setSavingOrder] = useState(false)
  const [cacheChecked, setCacheChecked] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const scanServerRef = useRef<string | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Progress events arrive faster than React should render; batch them to one update per frame.
  const batchRef = useRef({ progress: 0, modName: null as string | null, modsScanned: 0, dirty: false, raf: 0 })

  const stopTimers = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = null
    cancelAnimationFrame(batchRef.current.raf)
  }

  useEffect(
    () => () => {
      controllerRef.current?.abort()
      controllerRef.current = null
      stopTimers()
    },
    [],
  )

  // A scan for one server must not finish onto another.
  useEffect(() => {
    if (!controllerRef.current || scanServerRef.current === selectedServerId) return
    controllerRef.current.abort()
    controllerRef.current = null
    scanServerRef.current = null
    stopTimers()
    setProgress(0)
    setCurrentMod(null)
    setModsScanned(0)
    setTotalMods(0)
    setStreamConflicts([])
    setLoading(false)
  }, [selectedServerId])

  useEffect(() => {
    let mounted = true
    modsApi
      .getCachedConflicts()
      .then((cached: (ConflictScanResult & { _workshopIdsSnapshot?: string[]; _modIdsSnapshot?: string[] }) | null) => {
        if (!mounted || !cached) return
        setConflicts(cached)
        setError(null)
        setLastScanTime(new Date())
        setSnapshot(createConflictScanSnapshot(cached._workshopIdsSnapshot, cached._modIdsSnapshot))
      })
      .catch(() => {
        // A fresh scan still works without the cache.
      })
      .finally(() => {
        if (mounted) setCacheChecked(true)
      })
    return () => {
      mounted = false
    }
  }, [])

  const stale = useMemo(() => {
    if (!conflicts || !snapshot || !iniConfig) return false
    return createConflictScanSnapshot(iniConfig.workshopIds, iniConfig.modIds) !== snapshot
  }, [conflicts, snapshot, iniConfig])

  const scan = useCallback(async () => {
    const previous = controllerRef.current
    controllerRef.current = null
    scanServerRef.current = null
    previous?.abort()
    stopTimers()
    if (!selectedServerId) {
      setError('Select a server before scanning for conflicts.')
      setLoading(false)
      return
    }

    const controller = new AbortController()
    controllerRef.current = controller
    scanServerRef.current = selectedServerId
    const isCurrent = () => controllerRef.current === controller
    const lostConnection = () => notify('Scan failed', 'The connection to the scan dropped.', 'error')
    const loadCached = async () => {
      if (!isCurrent()) return
      setLoading(false)
      try {
        const cached = await modsApi.getCachedConflicts()
        if (!isCurrent()) return
        if (cached) {
          setConflicts(cached)
          setError('The scan disconnected, so these are the last saved results.')
        } else {
          setError('The connection to the scan dropped.')
          lostConnection()
        }
      } catch {
        if (!isCurrent()) return
        setError('The connection to the scan dropped.')
        lostConnection()
      }
    }

    setLoading(true)
    setProgress(0)
    setCurrentMod(null)
    setModsScanned(0)
    setTotalMods(0)
    setStreamConflicts([])
    batchRef.current = { progress: 0, modName: null, modsScanned: 0, dirty: false, raf: 0 }

    let completed = false
    let streamFailed = false
    let scannedSnapshot: string | null = null
    const resetIdle = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      const timer = setTimeout(() => {
        if (idleTimerRef.current !== timer || !isCurrent()) return
        idleTimerRef.current = null
        controllerRef.current = null
        scanServerRef.current = null
        controller.abort()
        cancelAnimationFrame(batchRef.current.raf)
        setError("The scan timed out. The server stopped answering.")
        setLoading(false)
      }, IDLE_TIMEOUT_MS)
      idleTimerRef.current = timer
    }
    resetIdle()

    try {
      const response = await apiFetch(apiUrl('/mods/conflicts/stream', selectedServerId).slice(4), {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
        timeout: 0,
      })
      if (!isCurrent()) return
      if (!response.ok || !response.body) {
        await loadCached()
        return
      }
      await readSseStream(response.body, ({ event, data: raw }) => {
        if (!isCurrent()) return
        resetIdle()
        try {
          if (event === 'init') {
            const payload = JSON.parse(raw)
            setError(null)
            setTotalMods(payload.totalWorkshopIds || 0)
            scannedSnapshot = createConflictScanSnapshot(payload.workshopIds, payload.modLoadOrder)
          } else if (event === 'mod-scanned') {
            const payload: ScanStreamModScanned = JSON.parse(raw)
            const batch = batchRef.current
            batch.progress = payload.progress
            batch.modName = payload.modName
            batch.modsScanned = payload.modsScanned
            if (!batch.dirty) {
              batch.dirty = true
              batch.raf = requestAnimationFrame(() => {
                if (!isCurrent()) return
                setProgress(batch.progress)
                setCurrentMod(batch.modName)
                setModsScanned(batch.modsScanned)
                batch.dirty = false
              })
            }
          } else if (event === 'conflict-found') {
            const payload: ScanStreamConflictFound = JSON.parse(raw)
            setStreamConflicts((prev) => [...prev, payload].slice(-50))
          } else if (event === 'phase') {
            const payload = JSON.parse(raw)
            setProgress(payload.progress)
            if (payload.phase === 'hashing') setCurrentMod('Comparing file contents…')
            if (payload.phase === 'grouping') setCurrentMod('Grouping results…')
          } else if (event === 'complete') {
            completed = true
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
            cancelAnimationFrame(batchRef.current.raf)
            batchRef.current.dirty = false
            try {
              setConflicts(JSON.parse(raw))
              setLastScanTime(new Date())
              setSnapshot(scannedSnapshot)
              setProgress(100)
            } catch {
              setError("The scan results couldn't be read.")
            } finally {
              setLoading(false)
            }
          } else if (event === 'error') {
            streamFailed = true
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
            try {
              setError(JSON.parse(raw).error || 'The scan failed.')
            } catch {
              setError('The connection to the scan dropped.')
            }
            setLoading(false)
            lostConnection()
          }
        } catch (parseError) {
          reportClientWarning(`SSE ${event} parse error.`, parseError)
        }
      })
      if (isCurrent() && !completed && !streamFailed) await loadCached()
    } catch {
      if (isCurrent()) await loadCached()
    } finally {
      if (isCurrent()) {
        stopTimers()
        controllerRef.current = null
        scanServerRef.current = null
        setLoading(false)
      }
    }
  }, [selectedServerId])

  /** Writes a load order and moves conflict winners to match it. */
  const saveOrder = useCallback(
    async (order: string[], success: { title: string; description: string }, failTitle: string) => {
      if (busyRef.current) return false
      if (serverChangedSinceLoad) {
        notify('The selected server changed', 'Reset the load order before saving.', 'error')
        return false
      }
      busyRef.current = true
      setSavingOrder(true)
      try {
        await modsApi.saveModOrder(order)
        setOrderedModIds(order)
        setConflicts((prev) => (prev ? recalculateConflictWinners(prev, order) : prev))
        setSnapshot(createConflictScanSnapshot(iniConfig?.workshopIds, order))
        notify(success.title, success.description, 'success')
        void fetchData()
        return true
      } catch (saveError) {
        notify(failTitle, getUserErrorMessage(saveError, "The load order wasn't saved."), 'error')
        return false
      } finally {
        setSavingOrder(false)
        busyRef.current = false
      }
    },
    [busyRef, serverChangedSinceLoad, setOrderedModIds, iniConfig?.workshopIds, fetchData],
  )

  /** Moves the winner to load right after the loser, so its files take priority. */
  const promoteModOverOpponent = useCallback(
    async (winnerModId: string, winnerName: string, loserModId: string, loserName: string) => {
      const source = iniConfig?.modIds?.length ? iniConfig.modIds : orderedModIds
      const next = [...source]
      const winnerIndex = next.indexOf(winnerModId)
      if (winnerIndex === -1 || next.indexOf(loserModId) === -1) {
        notify("Can't reorder", "One of these mods isn't in the load order.", 'error')
        return
      }
      next.splice(winnerIndex, 1)
      next.splice(next.indexOf(loserModId) + 1, 0, winnerModId)
      await saveOrder(next, { title: 'Load order changed', description: `${winnerName} now loads after ${loserName}.` }, "Couldn't change the load order")
    },
    [iniConfig?.modIds, orderedModIds, saveOrder],
  )

  return {
    conflicts,
    cacheChecked,
    loading,
    error,
    stale,
    lastScanTime,
    progress,
    currentMod,
    modsScanned,
    totalMods,
    streamConflicts,
    scan,
    savingOrder,
    saveOrder,
    promoteModOverOpponent,
  }
}

export type ConflictScan = ReturnType<typeof useConflictScan>
