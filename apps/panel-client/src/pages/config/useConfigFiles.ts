import { useCallback, useEffect, useRef, useState } from 'react'
import { serverFilesApi, type SandboxData, type SpawnPointsByProfession, type SpawnRegion } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { toastManager } from '@/components/ui/toast'
import { mergeIniDefaults, sandboxDefaults, type ConfigFile } from './configFiles'

export type Paths = Awaited<ReturnType<typeof serverFilesApi.getPaths>>

/** One edited value next to the copy last loaded from disk. */
interface Tracked<T> {
  value: T
  saved: T
}

const FILES: ConfigFile[] = ['ini', 'sandbox', 'spawnpoints', 'spawnregions']
const emptyRaw = (): Record<ConfigFile, Tracked<string> | null> => ({ ini: null, sandbox: null, spawnpoints: null, spawnregions: null })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The selected server's four config files, the edits on top of them, and raw text for files shown as text. */
export function useConfigFiles() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [paths, setPaths] = useState<Paths | null>(null)
  const [duplicateKeys, setDuplicateKeys] = useState<Array<{ key: string; count: number }>>([])
  const [ini, setIni] = useState<Tracked<Record<string, string>>>({ value: {}, saved: {} })
  const [sandbox, setSandbox] = useState<Tracked<SandboxData | null>>({ value: null, saved: null })
  const [spawnPoints, setSpawnPoints] = useState<Tracked<SpawnPointsByProfession>>({ value: {}, saved: {} })
  const [regions, setRegions] = useState<Tracked<SpawnRegion[]>>({ value: [], saved: [] })
  const [raw, setRaw] = useState(emptyRaw)
  const rawRef = useRef(raw)
  rawRef.current = raw

  const loadRaw = useCallback(async (file: ConfigFile, exists = true) => {
    try {
      const content = exists ? (await serverFilesApi.getRaw(file)).content : ''
      setRaw((prev) => ({ ...prev, [file]: { value: content, saved: content } }))
      return true
    } catch (error) {
      toastManager.add({ title: 'Could not open the file as text', description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
      return false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await serverFilesApi.getPaths()
      setPaths(next)
      const [iniData, sandboxData, pointsData, regionsData] = await Promise.all([
        next.exists.ini ? serverFilesApi.getIni() : null,
        next.exists.sandbox ? serverFilesApi.getSandbox() : null,
        next.exists.spawnpoints ? serverFilesApi.getSpawnPoints() : null,
        next.exists.spawnregions ? serverFilesApi.getSpawnRegions() : null,
      ])
      const settings = iniData ? mergeIniDefaults(iniData.settings) : {}
      setIni({ value: settings, saved: settings })
      setDuplicateKeys(iniData?.duplicateKeys ?? [])
      const sandboxValue = sandboxData?.sandbox ?? sandboxDefaults()
      setSandbox({ value: sandboxValue, saved: sandboxValue })
      setSpawnPoints({ value: pointsData?.spawnpoints ?? {}, saved: pointsData?.spawnpoints ?? {} })
      setRegions({ value: regionsData?.spawnregions ?? [], saved: regionsData?.spawnregions ?? [] })
      // Files open as text stay open as text, with fresh content.
      await Promise.all(FILES.filter((file) => rawRef.current[file]).map((file) => loadRaw(file, next.exists[file])))
      setLoadError(null)
    } catch (error) {
      setLoadError(getUserErrorMessage(error, 'The config files could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [loadRaw])

  useEffect(() => {
    void load()
  }, [load])

  /** Re-reads one file after a save, leaving unsaved edits in the others alone. */
  const reloadFile = useCallback(
    async (file: ConfigFile) => {
      try {
        const next = await serverFilesApi.getPaths()
        setPaths(next)
        if (rawRef.current[file]) await loadRaw(file, next.exists[file])
        if (file === 'ini') {
          const data = next.exists.ini ? await serverFilesApi.getIni() : null
          const settings = data ? mergeIniDefaults(data.settings) : {}
          setIni({ value: settings, saved: settings })
          setDuplicateKeys(data?.duplicateKeys ?? [])
        } else if (file === 'sandbox') {
          const value = next.exists.sandbox ? (await serverFilesApi.getSandbox()).sandbox : sandboxDefaults()
          setSandbox({ value, saved: value })
        } else if (file === 'spawnpoints') {
          const value = next.exists.spawnpoints ? (await serverFilesApi.getSpawnPoints()).spawnpoints : {}
          setSpawnPoints({ value, saved: value })
        } else {
          const value = next.exists.spawnregions ? (await serverFilesApi.getSpawnRegions()).spawnregions : []
          setRegions({ value, saved: value })
        }
      } catch {
        // The save went through; a failed re-read leaves the page showing what was just saved.
      }
    },
    [loadRaw],
  )

  const isDirty = (file: ConfigFile) => {
    const text = raw[file]
    if (text) return text.value !== text.saved
    if (file === 'ini') return !same(ini.value, ini.saved)
    if (file === 'sandbox') return !same(sandbox.value, sandbox.saved)
    if (file === 'spawnpoints') return !same(spawnPoints.value, spawnPoints.saved)
    return !same(regions.value, regions.saved)
  }

  const discard = (file: ConfigFile) => {
    if (raw[file]) setRaw((prev) => ({ ...prev, [file]: prev[file] && { ...prev[file], value: prev[file].saved } }))
    else if (file === 'ini') setIni((prev) => ({ ...prev, value: prev.saved }))
    else if (file === 'sandbox') setSandbox((prev) => ({ ...prev, value: prev.saved }))
    else if (file === 'spawnpoints') setSpawnPoints((prev) => ({ ...prev, value: prev.saved }))
    else setRegions((prev) => ({ ...prev, value: prev.saved }))
  }

  const setRawText = (file: ConfigFile, value: string) => setRaw((prev) => ({ ...prev, [file]: prev[file] && { ...prev[file], value } }))
  const closeRaw = (file: ConfigFile) => setRaw((prev) => ({ ...prev, [file]: null }))

  return {
    loading,
    loadError,
    paths,
    duplicateKeys,
    ini,
    setIni,
    sandbox,
    setSandbox,
    spawnPoints,
    regions,
    setRegions,
    raw,
    loadRaw,
    setRawText,
    closeRaw,
    load,
    reloadFile,
    isDirty,
    discard,
    anyDirty: FILES.some(isDirty),
  }
}

export type ConfigFiles = ReturnType<typeof useConfigFiles>
