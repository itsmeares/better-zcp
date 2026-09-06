import { useEffect, useState } from 'react'

/** Max conflicting files listed per pair before the "show all" toggle appears. */
export const CONFLICT_FILE_LIMIT = 12

export interface TrackedMod {
  id: number
  workshop_id: string
  name: string
  last_updated: string
  last_checked: string | null
  update_available: number
  created_at: string
  active?: boolean
}

export interface ModStatus {
  totalModsTracked: number
  totalModsInWorkshop: number
  updatesAvailable: number
  lastCheck: string | null
  lastUpdateDetected: string | null
  autoRestartEnabled: boolean
  running: boolean
  workshopAcfConfigured: boolean
  workshopAcfPath: string | null
  checkInterval: number
  modsNeedingUpdate: Array<{
    workshopId: string
    name: string
    localTimestamp: string
    latestTimestamp: string
  }>
  restartWarningMinutes: number
  delayIfPlayersOnline: boolean
  maxDelayMinutes: number
  pendingRestart: boolean
  // False only after a check that actually queried Steam and got nothing
  // back (outage/rate-limit/network block) -- true before the first check
  // ever runs. lastSteamApiFailureAt is re-stamped to the CURRENT time on
  // every consecutive failed cycle (not just the first one of a streak),
  // so it isn't a stable "outage started at" marker -- treat it as "most
  // recent failure seen", not an episode id.
  steamApiHealthy: boolean
  lastSteamApiFailureAt: string | null
  // Workshop ids Steam has explicitly confirmed no longer exist (EResult 9).
  // Distinct from an id that's merely unchecked this cycle or ambiguous --
  // see modChecker.js's getStatus() comment.
  removedWorkshopIds: string[]
  // Workshop ids Steam answered with something other than 1 (found) or 9
  // (removed) -- a real, distinct third state, not "removed" and not
  // "healthy". Show the raw resultCode, never invent prose for a code
  // that hasn't been individually verified against Steam's own docs.
  unknownWorkshopIds: Array<{ id: string; resultCode: number }>
}

export type ModEntry = { id: string; name: string; enabled: boolean; require?: string[] }
export type WsGroup = { wsId: string; mods: ModEntry[]; allEnabled: boolean; someEnabled: boolean }

export type DepSearchHit = {
  workshopId: string
  modId?: string
  modName: string
  description?: string
  subscriberCount?: number
  source: 'local' | 'steam'
  isDownloaded: boolean
  matchedVariant?: string
  relevance?: number
  matchType?: string
}

export type DepSearchState = {
  loading: boolean
  results: DepSearchHit[]
  error: string | null
  searchUrl: string | null
  variantsTried?: string[]
  steamSearchEnabled?: boolean
}

/** useState wrapper that persists the value to localStorage under a stable key. */
export function useLocalStorageState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return defaultValue
      return JSON.parse(raw) as T
    } catch { return defaultValue }
  })
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota or disabled — ignore */ }
  }, [key, value])
  return [value, setValue]
}
