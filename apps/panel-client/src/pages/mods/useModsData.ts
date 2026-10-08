import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { modsApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import type { ModStatus, TrackedMod } from '@/lib/modsShared'
import { useSocket } from '@/contexts/SocketContext'
import { notify, type IgnoredMod, type IgnoredPair, type IniConfig } from './modsShared'

const REFRESH_EVENTS = [
  'mods:update_detected',
  'mods:restart_pending',
  'mods:restart_starting',
  'mods:restart_cancelled',
  'mods:restart_failed',
  'mods:restart_complete',
  'mods:updates_available',
]

export interface CollectionStatus {
  configured: boolean
  inSync: boolean
  drift: number
  title: string | null
  error: string | null
  loading: boolean
}

/** Tracked mods, the server's Mods= and WorkshopItems=, ignore lists and the unsaved load order. */
export function useModsData() {
  const socket = useSocket()
  const [mods, setMods] = useState<TrackedMod[]>([])
  const [status, setStatus] = useState<ModStatus | null>(null)
  const [iniConfig, setIniConfig] = useState<IniConfig | null>(null)
  const [orderedModIds, setOrderedModIds] = useState<string[]>([])
  const [ignoredMods, setIgnoredMods] = useState<IgnoredMod[]>([])
  const [ignoredPairs, setIgnoredPairs] = useState<IgnoredPair[]>([])
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [serverChangedSinceLoad, setServerChangedSinceLoad] = useState(false)
  const [collectionStatus, setCollectionStatus] = useState<CollectionStatus>({ configured: false, inSync: false, drift: 0, title: null, error: null, loading: false })
  /** One write at a time. Most actions bail out while another is running. */
  const busyRef = useRef(false)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collectionEverConfigured = useRef(true)

  const fetchCollectionStatus = useCallback(async () => {
    if (!collectionEverConfigured.current) return
    setCollectionStatus((prev) => ({ ...prev, loading: true }))
    try {
      const diff = await modsApi.collectionDiff()
      collectionEverConfigured.current = !!diff.collectionId
      setCollectionStatus({
        configured: !!diff.collectionId,
        inSync: diff.ok && diff.toAdd.length === 0 && diff.toRemove.length === 0,
        drift: diff.ok ? diff.toAdd.length + diff.toRemove.length : 0,
        title: diff.title || null,
        error: diff.ok ? null : diff.error || null,
        loading: false,
      })
    } catch (error) {
      setCollectionStatus((prev) => ({ ...prev, loading: false, error: getUserErrorMessage(error, 'Network error') }))
    }
  }, [])

  const fetchData = useCallback(async () => {
    setFetchError(null)
    const results = await Promise.allSettled([
      modsApi.getTrackedMods(),
      modsApi.getStatus(),
      modsApi.getCurrentConfig(),
      modsApi.getIgnoredMods(),
      modsApi.getIgnoredModPairs(),
    ])
    const [tracked, statusResult, config, ignored, pairs] = results
    if (tracked.status === 'fulfilled') {
      setMods(tracked.value.mods || [])
    } else {
      reportClientError('Failed to fetch tracked mods.', tracked.reason)
      setFetchError('The mod list is unavailable. Retrying…')
      if (retryRef.current) clearTimeout(retryRef.current)
      retryRef.current = setTimeout(async () => {
        try {
          setMods((await modsApi.getTrackedMods()).mods || [])
          setFetchError(null)
        } catch (error) {
          reportClientError('Failed to retry tracked mods fetch.', error)
          setFetchError("The mod list couldn't load. Reload the page to try again.")
        }
      }, 1500)
    }
    if (statusResult.status === 'fulfilled') setStatus(statusResult.value)
    if (config.status === 'fulfilled') {
      setIniConfig(config.value)
      if (config.value?.modIds) setOrderedModIds(config.value.modIds)
    }
    if (ignored.status === 'fulfilled') setIgnoredMods(Array.isArray(ignored.value) ? ignored.value : [])
    if (pairs.status === 'fulfilled') setIgnoredPairs(Array.isArray(pairs.value) ? pairs.value : [])
    const failures = results.filter((result) => result.status === 'rejected')
    failures.forEach((result, index) => reportClientError(`Failed to fetch mods data (index ${index}).`, (result as PromiseRejectedResult).reason))
    if (failures.length === results.length) setFetchError("Mod data didn't load. The panel may be unreachable.")
    void fetchCollectionStatus()
  }, [fetchCollectionStatus])

  useEffect(() => {
    void fetchData()
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current)
    }
  }, [fetchData])

  // A collection set up in another tab shows up when this tab regains focus.
  useEffect(() => {
    const onFocus = () => {
      if (collectionEverConfigured.current) return
      collectionEverConfigured.current = true
      void fetchCollectionStatus()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [fetchCollectionStatus])

  useEffect(() => {
    if (!socket) return
    const refresh = () => void fetchData()
    for (const event of REFRESH_EVENTS) socket.on(event, refresh)
    return () => {
      for (const event of REFRESH_EVENTS) socket.off(event, refresh)
    }
  }, [socket, fetchData])

  const hasModOrderChanged = useMemo(() => {
    if (!iniConfig?.modIds) return false
    return orderedModIds.length !== iniConfig.modIds.length || orderedModIds.some((id, index) => id !== iniConfig.modIds[index])
  }, [orderedModIds, iniConfig?.modIds])

  // Switching servers under an unsaved load order would save it to the wrong server.
  useEffect(() => {
    if (!socket) return
    const onServersChanged = () => {
      if (hasModOrderChanged) {
        setServerChangedSinceLoad(true)
        notify('The selected server changed', 'Reset the load order before saving.', 'error')
        return
      }
      void fetchData()
    }
    socket.on('servers:changed', onServersChanged)
    return () => {
      socket.off('servers:changed', onServersChanged)
    }
  }, [socket, fetchData, hasModOrderChanged])

  useEffect(() => {
    if (serverChangedSinceLoad && !hasModOrderChanged) {
      setServerChangedSinceLoad(false)
      void fetchData()
    }
  }, [serverChangedSinceLoad, hasModOrderChanged, fetchData])

  /** Re-reads Mods= and WorkshopItems= after a change that only touches the server config. */
  const refreshConfig = useCallback(async () => {
    const updated = await modsApi.getCurrentConfig()
    setIniConfig(updated)
    if (updated?.modIds) setOrderedModIds(updated.modIds)
  }, [])

  /**
   * Runs one write with the shared busy guard and loading flag. Returns false if another write
   * was running or this one failed; the failure toast uses `failTitle`.
   */
  const runExclusive = useCallback(async (failTitle: string, action: () => Promise<void>) => {
    if (busyRef.current) return false
    busyRef.current = true
    setLoading(true)
    try {
      await action()
      return true
    } catch (error) {
      notify(failTitle, getUserErrorMessage(error, 'Try again.'), 'error')
      return false
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }, [])

  return {
    mods,
    status,
    iniConfig,
    setIniConfig,
    orderedModIds,
    setOrderedModIds,
    hasModOrderChanged,
    ignoredMods,
    ignoredPairs,
    setIgnoredPairs,
    fetchError,
    fetchData,
    refreshConfig,
    loading,
    busyRef,
    runExclusive,
    serverChangedSinceLoad,
    collectionStatus,
    fetchCollectionStatus,
  }
}

export type ModsData = ReturnType<typeof useModsData>
