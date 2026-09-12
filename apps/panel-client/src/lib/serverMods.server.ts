import { createServerFn } from '@tanstack/react-start'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth.server'

type AnyRecord = Record<string, any>
type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  params?: unknown
  status?: unknown
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const details = error as ServiceError
    if (typeof details.error === 'string') return details.error
    if (typeof details.message === 'string') return details.message
  }
  return String(error)
}

function throwModsError(error: unknown, fallbackStatus = 500): never {
  const details =
    error && typeof error === 'object' ? (error as ServiceError) : {}
  const status =
    typeof details.status === 'number' ? details.status : fallbackStatus
  throw Object.assign(new Error(errorMessage(error)), {
    status,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(details.params !== undefined ? { params: details.params } : {}),
  })
}

function invalid(message: string, code?: string): never {
  throwModsError(Object.assign(new Error(message), code ? { code } : {}), 400)
}

function capabilityMiddleware() {
  return [
    ...protectedServerFunctionMiddleware,
    permissionMiddleware('mods.manage'),
  ] as const
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

function createModRead<T>(handler: (data: AnyRecord) => Promise<T> | T) {
  const implementation = async (data: AnyRecord) => {
    try {
      return (await handler(data)) as T
    } catch (error) {
      throwModsError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'GET' })
      .middleware(capabilityMiddleware())
      .validator((data: unknown) => record(data))
      .handler(({ data }) => implementation(data) as any),
    { __executeImplementation: implementation },
  )
}

function createModAction<T>(handler: (data: AnyRecord) => Promise<T> | T) {
  const implementation = async (data: AnyRecord) => {
    try {
      return (await handler(data)) as T
    } catch (error) {
      throwModsError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'POST' })
      .middleware(capabilityMiddleware())
      .validator((data: unknown) => record(data))
      .handler(({ data }) => implementation(data) as any),
    { __executeImplementation: implementation },
  )
}

function workshopId(data: AnyRecord, key = 'workshopId'): string {
  const value = String(data[key] ?? '').trim()
  if (!/^\d{1,15}$/.test(value))
    invalid('Invalid workshop ID', 'MODS_INVALID_WORKSHOP_ID_LOWER')
  return value
}

async function getServerIniFile() {
  const { getActiveServer, getSetting } =
    await import('../../../panel-server/database/init.ts')
  const { join, basename } = await import('node:path')
  const activeServer = await getActiveServer()
  const configPath =
    activeServer?.serverConfigPath ||
    (activeServer?.zomboidDataPath
      ? join(activeServer.zomboidDataPath, 'Server')
      : await getSetting('serverConfigPath')) ||
    ((await getSetting('zomboidDataPath'))
      ? join(await getSetting('zomboidDataPath'), 'Server')
      : null)
  const serverName =
    activeServer?.serverName || (await getSetting('serverName'))
  if (!configPath || typeof serverName !== 'string') return null
  const safeName = basename(serverName)
  if (!safeName || safeName !== serverName || serverName.includes('..'))
    return null
  return { path: join(configPath, `${safeName}.ini`), serverName: safeName }
}

async function readIni(path: string): Promise<string | null> {
  const { existsSync, readFileSync } = await import('node:fs')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(
    /\r\n/g,
    '\n',
  )
}

export const getModsStatus = createModRead(async () => {
  const runtime = await panelRuntime()
  if (!runtime.modChecker)
    throw Object.assign(new Error('Mod checker not initialized'), {
      code: 'MOD_CHECKER_NOT_INITIALIZED',
    })
  return runtime.modChecker.getStatus()
})

export const getTrackedMods = createModRead(async () => {
  const {
    addTrackedMod,
    getTrackedMods: readTrackedMods,
    isModIgnored,
  } = await import('../../../panel-server/database/init.ts')
  const runtime = await panelRuntime()
  const iniFile = await getServerIniFile()
  const ini = iniFile ? await readIni(iniFile.path) : null
  const configuredIds = new Set(
    ini
      ?.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m)?.[1]
      ?.split(';')
      .filter((id) => /^\d{1,15}$/.test(id)) || [],
  )
  const tracked = await readTrackedMods()
  const trackedSet = new Set(tracked.map((mod) => mod.workshop_id))

  for (const id of configuredIds) {
    if (trackedSet.has(id) || (await isModIgnored(id))) continue
    await addTrackedMod(
      id,
      runtime.modChecker?.resolveModNameFromDisk(id) || `Workshop Mod ${id}`,
    )
  }

  const mods = await readTrackedMods()
  const unresolvedIds: string[] = []
  for (const mod of mods) {
    const placeholder =
      !mod.name ||
      /^Workshop Mod /i.test(mod.name) ||
      /\[\s*Legacy\s*\]/i.test(mod.name)
    if (!placeholder) continue
    const name = runtime.modChecker?.resolveModNameFromDisk(
      mod.workshop_id,
      true,
    )
    if (name && name !== mod.name) {
      mod.name = name
      await addTrackedMod(mod.workshop_id, name)
    } else {
      unresolvedIds.push(mod.workshop_id)
    }
  }

  if (unresolvedIds.length) {
    const { fetchPublishedFileTitles } =
      await import('../../../panel-server/services/workshopCollectionSync.ts')
    const titles = await fetchPublishedFileTitles(unresolvedIds)
    for (const mod of mods) {
      const name = titles.get(mod.workshop_id)
      if (
        name &&
        (!mod.name ||
          /^Workshop Mod /i.test(mod.name) ||
          /\[\s*Legacy\s*\]/i.test(mod.name))
      ) {
        mod.name = name
        await addTrackedMod(mod.workshop_id, name)
      }
    }
  }

  return { mods }
})

export const trackMod = createModAction(async (data) => {
  const id = workshopId(data)
  const { removeIgnoredMod } =
    await import('../../../panel-server/database/init.ts')
  const { syncSingleChange: autoSyncCollection } =
    await import('../../../panel-server/services/workshopCollectionSync.ts')
  const runtime = await panelRuntime()
  if (!runtime.modChecker)
    throw Object.assign(new Error('Mod checker not initialized'), {
      code: 'MOD_CHECKER_NOT_INITIALIZED',
    })
  await removeIgnoredMod(id)
  const result = await runtime.modChecker.addModToTrack(id)
  autoSyncCollection('add', id).catch(() => {})
  return result
})

export const untrackMod = createModAction(async (data) => {
  const id = workshopId(data)
  const {
    addIgnoredMod,
    getTrackedMods: readTrackedMods,
    removeTrackedMod,
  } = await import('../../../panel-server/database/init.ts')
  const { syncSingleChange: autoSyncCollection } =
    await import('../../../panel-server/services/workshopCollectionSync.ts')
  const tracked = await readTrackedMods()
  const mod = tracked.find((entry) => entry.workshop_id === id)
  await removeTrackedMod(id)
  await addIgnoredMod(id, mod?.name || null)
  autoSyncCollection('remove', id).catch(() => {})
  return {
    success: true,
    message: 'Mod removed from tracking and added to ignore list',
  }
})

export const getIgnoredMods = createModRead(async () => {
  const { getIgnoredMods } =
    await import('../../../panel-server/database/init.ts')
  return getIgnoredMods()
})

export const unignoreMod = createModAction(async (data) => {
  const id = workshopId(data)
  const { removeIgnoredMod } =
    await import('../../../panel-server/database/init.ts')
  if (!(await removeIgnoredMod(id)))
    throw Object.assign(new Error('Mod not found in ignore list'), {
      status: 404,
      code: 'MODS_IGNORE_ENTRY_NOT_FOUND',
    })
  return { success: true, message: 'Mod removed from ignore list' }
})

export const clearAllIgnoredMods = createModAction(async () => {
  const { clearAllIgnoredMods } =
    await import('../../../panel-server/database/init.ts')
  const removed = await clearAllIgnoredMods()
  return {
    success: true,
    message: `Cleared ${removed} ignored mod${removed !== 1 ? 's' : ''}`,
    removed,
  }
})

const MOD_ID_RE = /^[A-Za-z0-9_.\-+ ()]{1,128}$/

export const getIgnoredModPairs = createModRead(async () => {
  const { getIgnoredModPairs } =
    await import('../../../panel-server/database/init.ts')
  return getIgnoredModPairs()
})

export const addIgnoredModPair = createModAction(async (data) => {
  const modIdA = data.modIdA
  const modIdB = data.modIdB
  if (
    typeof modIdA !== 'string' ||
    typeof modIdB !== 'string' ||
    !MOD_ID_RE.test(modIdA) ||
    !MOD_ID_RE.test(modIdB)
  )
    invalid(
      'modIdA and modIdB are required and must be valid mod IDs',
      'MODS_IGNORED_PAIR_INVALID_IDS',
    )
  if (modIdA === modIdB)
    invalid('modIdA and modIdB must differ', 'MODS_IGNORED_PAIR_SAME_ID')
  const { addIgnoredModPair } =
    await import('../../../panel-server/database/init.ts')
  const entry = await addIgnoredModPair(
    modIdA,
    modIdB,
    typeof data.reason === 'string' ? data.reason.slice(0, 200) : null,
  )
  if (!entry) invalid('Invalid pair', 'MODS_IGNORED_PAIR_INVALID')
  return { success: true, pair: entry }
})

export const removeIgnoredModPair = createModAction(async (data) => {
  const modIdA = data.modIdA
  const modIdB = data.modIdB
  if (
    typeof modIdA !== 'string' ||
    typeof modIdB !== 'string' ||
    !MOD_ID_RE.test(modIdA) ||
    !MOD_ID_RE.test(modIdB)
  )
    invalid('modIdA and modIdB are required', 'MODS_IGNORED_PAIR_IDS_REQUIRED')
  const { removeIgnoredModPair } =
    await import('../../../panel-server/database/init.ts')
  if (!(await removeIgnoredModPair(modIdA, modIdB)))
    throw Object.assign(new Error('Pair not found in ignore list'), {
      status: 404,
      code: 'MODS_IGNORED_PAIR_NOT_FOUND',
    })
  return { success: true }
})

export const getServerMods = createModRead(async () => {
  const runtime = await panelRuntime()
  return { mods: await runtime.serverManager.getModList() }
})

export const startModChecker = createModAction(async () => {
  const runtime = await panelRuntime()
  if (!runtime.modChecker)
    throw Object.assign(new Error('Mod checker not initialized'), {
      code: 'MOD_CHECKER_NOT_INITIALIZED',
    })
  if (!runtime.modChecker.start())
    invalid(
      'Mod checker could not start. Configure a valid Workshop ACF path first.',
      'MODS_START_ACF_PATH_NOT_SET',
    )
  return { success: true, message: 'Mod checker started' }
})

export const stopModChecker = createModAction(async () => {
  const runtime = await panelRuntime()
  if (!runtime.modChecker)
    throw Object.assign(new Error('Mod checker not initialized'), {
      code: 'MOD_CHECKER_NOT_INITIALIZED',
    })
  runtime.modChecker.stop()
  return { success: true, message: 'Mod checker stopped' }
})

export const setModAutoRestart = createModAction(async (data) => {
  if (typeof data.enabled !== 'boolean')
    invalid('`enabled` must be a boolean', 'MODS_AUTO_RESTART_ENABLED_REQUIRED')
  const runtime = await panelRuntime()
  if (!runtime.modChecker)
    throw Object.assign(new Error('Mod checker not initialized'), {
      code: 'MOD_CHECKER_NOT_INITIALIZED',
    })
  if (data.enabled) {
    await runtime.modChecker.setUpdateCallback(
      async (updatedMods: AnyRecord) => {
        const result = await runtime.modChecker.handleModUpdate(updatedMods)
        return result
      },
    )
  } else {
    await runtime.modChecker.setUpdateCallback(null)
  }
  return { success: true, autoRestart: data.enabled }
})

export const setModRestartOptions = createModAction(async (data) => {
  const { parseBoundedInteger } =
    await import('../../../panel-server/utils/queryNumbers.ts')
  const inRange = (value: unknown, min: number, max: number) =>
    parseBoundedInteger(value, null, min, max) !== null
  if (data.warningMinutes !== undefined && !inRange(data.warningMinutes, 0, 30))
    invalid(
      'warningMinutes must be a whole number from 0 to 30',
      'MODS_RESTART_WARNING_MINUTES_INVALID',
    )
  if (
    data.maxDelayMinutes !== undefined &&
    !inRange(data.maxDelayMinutes, 5, 120)
  )
    invalid(
      'maxDelayMinutes must be a whole number from 5 to 120',
      'MODS_RESTART_MAX_DELAY_MINUTES_INVALID',
    )
  const interval =
    data.checkInterval === undefined
      ? null
      : parseBoundedInteger(data.checkInterval, null, 60_000, 120 * 60 * 1000)
  if (
    data.checkInterval !== undefined &&
    (interval === null || interval % 60_000 !== 0)
  )
    invalid(
      'checkInterval must be a whole number of minutes from 60000ms to 7200000ms',
      'MODS_RESTART_CHECK_INTERVAL_INVALID',
    )
  if (
    data.delayIfPlayersOnline !== undefined &&
    typeof data.delayIfPlayersOnline !== 'boolean'
  )
    invalid(
      'delayIfPlayersOnline must be a boolean',
      'MODS_RESTART_DELAY_IF_PLAYERS_ONLINE_INVALID',
    )

  const runtime = await panelRuntime()
  if (!runtime.modChecker)
    throw Object.assign(new Error('Mod checker not initialized'), {
      code: 'MOD_CHECKER_NOT_INITIALIZED',
    })
  await runtime.modChecker.setRestartOptions({
    warningMinutes: data.warningMinutes,
    delayIfPlayersOnline: data.delayIfPlayersOnline,
    maxDelayMinutes: data.maxDelayMinutes,
    checkInterval: data.checkInterval,
  })
  const status = await runtime.modChecker.getStatus()
  return {
    success: true,
    options: {
      warningMinutes: status.restartWarningMinutes,
      delayIfPlayersOnline: status.delayIfPlayersOnline,
      maxDelayMinutes: status.maxDelayMinutes,
      checkInterval: status.checkInterval,
    },
  }
})

export const getWorkshopStatus = createModRead(async () => {
  const runtime = await panelRuntime()
  if (!runtime.modChecker)
    throw Object.assign(new Error('Mod checker not initialized'), {
      code: 'MOD_CHECKER_NOT_INITIALIZED',
    })
  const status = await runtime.modChecker.getStatus()
  return {
    success: true,
    configured: status.workshopAcfConfigured,
    workshopAcfPath: status.workshopAcfPath,
    message: status.workshopAcfConfigured
      ? 'Workshop ACF file found - mod updates can be detected automatically'
      : 'Workshop ACF file not found - ensure server install path is correct',
  }
})

export const cancelPendingModRestart = createModAction(async () => {
  const runtime = await panelRuntime()
  if (!runtime.modChecker)
    throw Object.assign(new Error('Mod checker not initialized'), {
      code: 'MOD_CHECKER_NOT_INITIALIZED',
    })
  if (!runtime.modChecker.pendingRestart)
    return { success: false, message: 'No pending restart to cancel' }
  runtime.modChecker.cancelPendingRestart()
  return { success: true, message: 'Pending restart cancelled' }
})

export const getModPresets = createModRead(async () => {
  const { getModPresets } =
    await import('../../../panel-server/database/init.ts')
  return { presets: await getModPresets() }
})

export const updateModPreset = createModAction(async (data) => {
  const id = String(data.id ?? '')
  if (!id) invalid('Invalid preset ID', 'MODS_INVALID_PRESET_ID')
  const updates: AnyRecord = {}
  if (data.name !== undefined) {
    if (typeof data.name !== 'string')
      invalid(
        'name must be a string',
        'MODS_PRESET_UPDATE_NAME_STRING_REQUIRED',
      )
    const name = data.name.trim()
    if (!name || name.length > 100)
      invalid(
        'name must be 1-100 characters',
        'MODS_PRESET_UPDATE_NAME_LENGTH_INVALID',
      )
    updates.name = name
  }
  if (data.description !== undefined)
    updates.description =
      typeof data.description === 'string'
        ? data.description.trim().slice(0, 500)
        : ''
  if (data.workshopIds !== undefined) {
    if (!Array.isArray(data.workshopIds))
      invalid(
        'workshopIds must be an array',
        'MODS_PRESET_UPDATE_WORKSHOP_IDS_ARRAY',
      )
    updates.workshop_ids = data.workshopIds
  }
  if (data.modIds !== undefined) {
    if (!Array.isArray(data.modIds))
      invalid('modIds must be an array', 'MODS_MOD_IDS_ARRAY_REQUIRED')
    updates.mods = data.modIds
  }
  const { updateModPreset } =
    await import('../../../panel-server/database/init.ts')
  const preset = await updateModPreset(id, updates)
  if (!preset)
    throw Object.assign(new Error('Preset not found'), {
      status: 404,
      code: 'MODS_PRESET_NOT_FOUND',
    })
  return { preset, message: 'Preset updated successfully' }
})

export const deleteModPreset = createModAction(async (data) => {
  const id = String(data.id ?? '')
  if (!id) invalid('Invalid preset ID', 'MODS_INVALID_PRESET_ID')
  const { deleteModPreset } =
    await import('../../../panel-server/database/init.ts')
  if (!(await deleteModPreset(id)))
    throw Object.assign(new Error('Preset not found'), {
      status: 404,
      code: 'MODS_PRESET_NOT_FOUND',
    })
  return { message: 'Preset deleted successfully' }
})

export const addCollectionItem = createModAction(async (data) => {
  const { getSetting } = await import('../../../panel-server/database/init.ts')
  const collectionId = await getSetting('workshopCollectionId')
  if (!collectionId)
    invalid('Collection ID not configured', 'MODS_COLLECTION_ID_NOT_CONFIGURED')
  const id = workshopId(data)
  const { addItemToCollection } =
    await import('../../../panel-server/services/workshopCollectionSync.ts')
  const result = await addItemToCollection(collectionId, id)
  if (!result.ok)
    throw Object.assign(
      new Error(result.error || 'Steam rejected the change'),
      { status: 502 },
    )
  return { ok: true, workshopId: id, action: 'add' as const }
})

export const removeCollectionItem = createModAction(async (data) => {
  const { getSetting } = await import('../../../panel-server/database/init.ts')
  const collectionId = await getSetting('workshopCollectionId')
  if (!collectionId)
    invalid('Collection ID not configured', 'MODS_COLLECTION_ID_NOT_CONFIGURED')
  const id = workshopId(data)
  const { removeItemFromCollection } =
    await import('../../../panel-server/services/workshopCollectionSync.ts')
  const result = await removeItemFromCollection(collectionId, id)
  if (!result.ok)
    throw Object.assign(
      new Error(result.error || 'Steam rejected the change'),
      { status: 502 },
    )
  return { ok: true, workshopId: id, action: 'remove' as const }
})

export const removeCollectionTracking = createModAction(async (data) => {
  const id = workshopId(data)
  const { removeTrackedMod } =
    await import('../../../panel-server/database/init.ts')
  const removed = await removeTrackedMod(id)
  return {
    ok: true,
    workshopId: id,
    removed,
    message: removed
      ? 'Mod is no longer tracked; Steam collection and server configuration were unchanged'
      : 'Mod was not tracked',
  }
})

export const saveCollectionCookies = createModAction(async (data) => {
  const sessionid =
    typeof data.sessionid === 'string' ? data.sessionid.trim() : ''
  const loginSecure =
    typeof data.steamLoginSecure === 'string'
      ? data.steamLoginSecure.trim()
      : ''
  if (!sessionid || !loginSecure)
    invalid(
      'Both sessionid and steamLoginSecure are required',
      'MODS_COOKIE_VALUES_REQUIRED',
    )
  if (/[\r\n\0;]/.test(sessionid) || /[\r\n\0;]/.test(loginSecure))
    invalid(
      'Cookie values contain forbidden control characters',
      'MODS_COOKIE_VALUES_CONTROL_CHARS',
    )
  if (sessionid.length > 4096 || loginSecure.length > 4096)
    invalid(
      'Cookie values are unexpectedly long',
      'MODS_COOKIE_VALUES_TOO_LONG',
    )
  const { setSteamSessionCredentials } =
    await import('../../../panel-server/services/workshopCollectionSync.ts')
  await setSteamSessionCredentials(sessionid, loginSecure)
  return { ok: true, message: 'Cookies saved' }
})
