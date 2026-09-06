import { useEffect, useState } from 'react'

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
  steamApiHealthy: boolean
  lastSteamApiFailureAt: string | null
  removedWorkshopIds: string[]
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
