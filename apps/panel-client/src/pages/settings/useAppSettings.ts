import { useCallback, useEffect, useState } from 'react'
import { configApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'

/** Panel-wide settings stored by /config/app-settings. Values arrive as strings or booleans. */
export interface AppSettings {
  autoStartServer: boolean
  autoReconnect: boolean
  reconnectInterval: string
  panelPort: string
  steamUpdateAccount: string
  modCheckInterval: string
  steamApiKey: string
  workshopCollectionId: string
  corsAllowedOrigins: string
  corsAllowAll: boolean
  corsAllowPrivateNetworks: boolean
  corsDebug: boolean
  enablePublicIpLookup: boolean
  lanIpAddress: string
}

const DEFAULTS: AppSettings = {
  autoStartServer: false,
  autoReconnect: true,
  reconnectInterval: '5',
  panelPort: '3001',
  steamUpdateAccount: '',
  modCheckInterval: '5',
  steamApiKey: '',
  workshopCollectionId: '',
  corsAllowedOrigins: '',
  corsAllowAll: false,
  corsAllowPrivateNetworks: true,
  corsDebug: false,
  enablePublicIpLookup: false,
  lanIpAddress: '',
}

const NUMERIC_KEYS: (keyof AppSettings)[] = ['modCheckInterval', 'reconnectInterval', 'panelPort']

function normalize(incoming: Record<string, unknown>): AppSettings {
  const next = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as (keyof AppSettings)[]) {
    const value = incoming[key]
    if (value === undefined || value === null) continue
    if (typeof DEFAULTS[key] === 'boolean') {
      ;(next as Record<string, unknown>)[key] = value === true || value === 'true'
    } else {
      ;(next as Record<string, unknown>)[key] = String(value)
    }
  }
  return next
}

/**
 * Loads app settings and tracks edits. save() sends only the keys that changed,
 * so pages that edit different settings never overwrite each other.
 */
export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS)
  const [saved, setSaved] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const data = await configApi.getAppSettings()
      const loaded = normalize((data.settings ?? {}) as Record<string, unknown>)
      setSettings(loaded)
      setSaved(loaded)
      setLoadError(null)
    } catch (error) {
      reportClientError('Failed to fetch settings.', error)
      setLoadError(getUserErrorMessage(error, 'The settings request failed.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (typeof value === 'string' && NUMERIC_KEYS.includes(key) && value !== '' && Number.isNaN(Number.parseInt(value, 10))) return
    setSettings((prev) => ({ ...prev, [key]: value }))
  }, [])

  const changed = saved
    ? (Object.keys(settings) as (keyof AppSettings)[]).filter((key) => settings[key] !== saved[key])
    : []

  const save = useCallback(async () => {
    if (!saved) return
    const patch = Object.fromEntries(changed.map((key) => [key, settings[key]]))
    setSaving(true)
    try {
      await configApi.updateAppSettings(patch)
      setSaved(settings)
    } finally {
      setSaving(false)
    }
  }, [changed, saved, settings])

  const discard = useCallback(() => {
    if (saved) setSettings(saved)
  }, [saved])

  return { settings, saved, update, save, discard, reload, loading, loadError, saving, isDirty: changed.length > 0, changed }
}

export type AppSettingsState = ReturnType<typeof useAppSettings>
