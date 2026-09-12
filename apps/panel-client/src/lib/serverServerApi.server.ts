import '@tanstack/react-start/server-only'

import fs from 'node:fs'
import path from 'node:path'
import { createServerFn } from '@tanstack/react-start'
import { ErrorCode } from '../../../panel-server/utils/errorCodes.ts'
import { parseBoundedInteger } from '../../../panel-server/utils/queryNumbers.ts'
import { sanitizeIniValue } from '../../../panel-server/utils/sanitize.ts'
import { setIniKeyLine } from '../../../panel-server/utils/iniKeyWrite.ts'
import {
  withFileLock,
  writeFileAtomic,
} from '../../../panel-server/utils/fileWriteQueue.ts'
import { applyUpnpToIni } from '../../../panel-server/utils/upnpConfig.ts'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth.server'

type AnyRecord = Record<string, any>

type ServiceError = {
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
  return error instanceof Error ? error.message : String(error)
}

function throwServerError(error: unknown, fallbackStatus = 500): never {
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
  throwServerError(Object.assign(new Error(message), code ? { code } : {}), 400)
}

function updateCheckerUnavailable(): never {
  throwServerError(
    Object.assign(new Error('Update checker not available'), {
      code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE,
      status: 503,
    }),
    503,
  )
}

function capabilityMiddleware(capability: string) {
  return [
    ...protectedServerFunctionMiddleware,
    permissionMiddleware(capability),
  ] as const
}

function createServerRead<T>(
  capability: string | null,
  handler: (data: AnyRecord) => Promise<T> | T,
) {
  const serverFn = createServerFn({ method: 'GET' })
  const secured = capability
    ? serverFn.middleware(capabilityMiddleware(capability))
    : serverFn.middleware(protectedServerFunctionMiddleware)
  const implementation = async (data: AnyRecord): Promise<T> => {
    try {
      return await handler(data)
    } catch (error) {
      throwServerError(error)
    }
  }
  return Object.assign(
    secured
      .validator((data: unknown) => record(data))
      .handler(({ data }) => implementation(data) as any),
    { __executeImplementation: implementation },
  )
}

function createServerAction<T>(
  capability: string,
  handler: (data: AnyRecord) => Promise<T> | T,
) {
  const implementation = async (data: AnyRecord): Promise<T> => {
    try {
      return await handler(data)
    } catch (error) {
      throwServerError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'POST' })
      .middleware(capabilityMiddleware(capability))
      .validator((data: unknown) => record(data))
      .handler(({ data }) => implementation(data) as any),
    { __executeImplementation: implementation },
  )
}

async function database() {
  return import('../../../panel-server/database/init.ts')
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

async function consoleLogPath(): Promise<string> {
  const { getActiveServer, getSetting } = await database()
  const activeServer = await getActiveServer()
  const dataPath =
    activeServer?.zomboidDataPath ||
    activeServer?.installPath ||
    (await getSetting('zomboidDataPath')) ||
    (await getSetting('serverPath'))
  if (!dataPath) {
    invalid(
      'Server data path not configured',
      ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED,
    )
  }
  return path.join(dataPath, 'server-console.txt')
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT',
  )
}

function withOpenReadFile<T>(
  filePath: string,
  handler: (fd: number, stats: fs.Stats) => T,
): T | null {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }

  try {
    return handler(fd, fs.fstatSync(fd))
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // Best effort: the original endpoint ignored close failures too.
    }
  }
}

function readTail(fd: number, size: number, maxBytes: number): string {
  if (size <= maxBytes) return fs.readFileSync(fd, 'utf-8')

  const buffer = Buffer.alloc(maxBytes)
  try {
    fs.readSync(fd, buffer, 0, maxBytes, size - maxBytes)
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // Best effort: the original endpoint ignored close failures too.
    }
  }
  const raw = buffer.toString('utf-8')
  const firstNewline = raw.indexOf('\n')
  return firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw
}

const CONSOLE_LOG_EXCLUDE_PATTERNS = [
  /IsoSpriteManager\.AddSprite > duplicate texture/,
  /The packet PlayerHitZombie is not consistent/,
  /XuiSkin\$EntityUiStyle\.Load > Could not find icon:/,
  /XuiSkin\$EntityUiStyle\.LoadComponentInfo> Could not find icon:/,
  /LuaManager\.RunLua > recursive require\(\)/,
  /The AnimalPacket class doesn't have PacketSetting attributes/,
  /The AnimalEventPacket class doesn't have PacketSetting attributes/,
]

const CONSOLE_LOG_ERROR_PATTERNS = [
  /^ERROR\[/,
  /Exception thrown/,
  /Stack trace:/,
  /java\.lang\.\w+Exception/,
  /KahluaThread\.flushErrorMessage/,
]

const CONSOLE_LOG_IMPORTANT_PATTERNS = [
  /^\[PanelBridge\]/,
  /SERVER STARTED/,
  /fully-connected/,
  /player-connect/,
  /connection-lost/,
  /disconnect/,
  /Steam client .* is initiating/,
  /RCON:/,
  /Recipe AutoLearned/,
  /Reduce Head Condition/,
  /ISBuildIsoEntity/,
]

function filterConsoleLogLines(
  lines: string[],
  filterLevel = 'filtered',
): string[] {
  if (filterLevel === 'all') return lines

  return lines.filter((line) => {
    if (!line.trim()) return false
    const isError = CONSOLE_LOG_ERROR_PATTERNS.some((pattern) =>
      pattern.test(line),
    )
    if (isError) return true

    const isImportant = CONSOLE_LOG_IMPORTANT_PATTERNS.some((pattern) =>
      pattern.test(line),
    )
    if (isImportant) return true
    if (filterLevel === 'errors') return isError
    if (filterLevel === 'important') return isError || isImportant

    const isNoise = CONSOLE_LOG_EXCLUDE_PATTERNS.some((pattern) =>
      pattern.test(line),
    )
    return !isNoise
  })
}

export const getConsoleLog = createServerRead(
  'server.world_events',
  async (data) => {
    const filePath = await consoleLogPath()
    const result = withOpenReadFile(filePath, (fd, stats) => {
      const filterLevel =
        typeof data.filter === 'string' ? data.filter : 'filtered'
      const maxLines = parseBoundedInteger(data.lines, 500, 1, 2000)
      const allLines = readTail(fd, stats.size, 5 * 1024 * 1024).split('\n')
      const filteredLines = filterConsoleLogLines(allLines, filterLevel)
      const lines = filteredLines.slice(-maxLines)

      return {
        success: true,
        content: lines.join('\n'),
        lines,
        totalLines: allLines.length,
        filteredCount: filteredLines.length,
        filterLevel,
        exists: true,
        path: filePath,
        lastModified: stats.mtime.toISOString(),
        size: stats.size,
      }
    })
    if (result === null) {
      return {
        success: true,
        content: '',
        lines: [],
        exists: false,
        path: filePath,
      }
    }
    return result
  },
)

let errorCountCache: { at: number; value: AnyRecord | null } = {
  at: 0,
  value: null,
}

export const getConsoleErrorCount = createServerRead(
  'server.world_events',
  async () => {
    const now = Date.now()
    if (errorCountCache.value && now - errorCountCache.at < 20_000) {
      return errorCountCache.value
    }

    let filePath: string
    try {
      filePath = await consoleLogPath()
    } catch (error) {
      const details = error as ServiceError
      if (details.code === ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED) {
        return { exists: false, count: 0, sinceStart: false }
      }
      throw error
    }
    const result = withOpenReadFile(filePath, (fd, stats) => {
      const truncated = stats.size > 2 * 1024 * 1024
      const lines = readTail(fd, stats.size, 2 * 1024 * 1024).split('\n')
      let startIndex = -1
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (/SERVER STARTED/.test(lines[index])) {
          startIndex = index
          break
        }
      }
      const scanned = startIndex >= 0 ? lines.slice(startIndex) : lines
      const count = scanned.filter((line) =>
        CONSOLE_LOG_ERROR_PATTERNS.some((pattern) => pattern.test(line)),
      ).length
      return {
        exists: true,
        count,
        sinceStart: startIndex >= 0,
        truncated,
        lastModified: stats.mtime.toISOString(),
      }
    })
    if (result === null) {
      return { exists: false, count: 0, sinceStart: false }
    }
    const payload = result
    errorCountCache = { at: now, value: payload }
    return payload
  },
)

export const getConsoleLogStream = createServerRead(
  'server.world_events',
  async (data) => {
    const filePath = await consoleLogPath()
    const result = withOpenReadFile(filePath, (fd, stats) => {
      const filterLevel =
        typeof data.filter === 'string' ? data.filter : 'filtered'
      const lastSize = parseBoundedInteger(
        data.lastSize,
        0,
        0,
        Number.MAX_SAFE_INTEGER,
      )

      if (stats.size < lastSize) {
        const lines = fs
          .readFileSync(fd, 'utf-8')
          .split('\n')
          .filter((line) => line.trim())
        return {
          success: true,
          newLines: filterConsoleLogLines(lines, filterLevel),
          currentSize: stats.size,
          rotated: true,
          filterLevel,
          lastModified: stats.mtime.toISOString(),
        }
      }

      if (stats.size === lastSize) {
        return {
          success: true,
          newLines: [],
          currentSize: stats.size,
          filterLevel,
          lastModified: stats.mtime.toISOString(),
        }
      }

      const newBytes = stats.size - lastSize
      const buffer = Buffer.alloc(newBytes)
      fs.readSync(fd, buffer, 0, newBytes, lastSize)
      const newLines = filterConsoleLogLines(
        buffer
          .toString('utf-8')
          .split('\n')
          .filter((line) => line.trim()),
        filterLevel,
      )
      return {
        success: true,
        newLines,
        currentSize: stats.size,
        filterLevel,
        lastModified: stats.mtime.toISOString(),
      }
    })
    if (result === null) {
      return { success: true, newLines: [], exists: false }
    }
    return result
  },
)

export const clearConsoleLog = createServerAction(
  'server.configure',
  async () => {
    const filePath = await consoleLogPath()
    try {
      const fd = fs.openSync(filePath, 'r+')
      try {
        fs.ftruncateSync(fd, 0)
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
    return { success: true }
  },
)

function isValidPath(inputPath: unknown): inputPath is string {
  if (typeof inputPath !== 'string' || !inputPath) return false
  if (inputPath.includes('..')) return false
  const normalized = path.normalize(inputPath)
  return !normalized.includes('..') && path.isAbsolute(normalized)
}

function steamCmdExecutable(steamcmdPath: string): string {
  const isWindows = process.platform === 'win32'
  const primary = path.join(
    steamcmdPath,
    isWindows ? 'steamcmd.exe' : 'steamcmd.sh',
  )
  if (fs.existsSync(primary)) return primary
  const fallback = path.join(steamcmdPath, 'steamcmd')
  if (!isWindows && fs.existsSync(fallback)) return fallback
  if (!isWindows) {
    for (const systemPath of [
      '/usr/games/steamcmd',
      '/usr/bin/steamcmd',
      '/usr/local/bin/steamcmd',
    ]) {
      if (fs.existsSync(systemPath)) return systemPath
    }
  }
  return primary
}

export const checkSteamCmd = createServerRead(
  'server.install',
  async (data) => {
    const checkPath = typeof data.path === 'string' ? data.path : null
    if (!checkPath || !isValidPath(checkPath)) {
      return { exists: false, message: 'Invalid path' }
    }
    const executable = steamCmdExecutable(checkPath)
    const exists = fs.existsSync(executable)
    return {
      exists,
      path: checkPath,
      executable,
      message: exists
        ? 'SteamCMD found'
        : 'SteamCMD not found at this location',
    }
  },
)

async function serverConfig(): Promise<{
  configPath: string | null
  name: string | null
}> {
  const { getActiveServer, getSetting } = await database()
  const activeServer = await getActiveServer()
  const configPath =
    activeServer?.serverConfigPath ||
    (await getSetting('serverConfigPath')) ||
    null
  const name =
    activeServer?.serverName || (await getSetting('serverName')) || null
  return { configPath, name }
}

function requireIntInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const text = typeof value === 'string' ? value.trim() : null
  const number =
    typeof value === 'number'
      ? value
      : text && /^[+-]?\d+$/.test(text)
        ? Number(text)
        : Number.NaN
  if (!Number.isInteger(number) || number < min || number > max) {
    return {
      ok: false,
      message: `${label} must be a whole number between ${min} and ${max}.`,
    }
  }
  return { ok: true, value: number }
}

async function requireIniPath(): Promise<string> {
  const { configPath, name } = await serverConfig()
  if (!configPath || !name) {
    invalid(
      'Server config path not set. Please run installation first.',
      ErrorCode.SERVER_CONFIG_PATH_NOT_SET,
    )
  }
  const iniPath = path.join(configPath, `${name}.ini`)
  if (!fs.existsSync(iniPath)) {
    invalid(
      `Server config not found at ${iniPath}. Start the server once first to generate the config file.`,
      ErrorCode.SERVER_CONFIG_FILE_NOT_FOUND,
    )
  }
  return iniPath
}

export const configureRcon = createServerAction(
  'server.configure',
  async (data) => {
    const password = data.rconPassword
    const portCheck = requireIntInRange(
      data.rconPort === undefined ? 27015 : data.rconPort,
      1024,
      65535,
      'RCON port',
    )
    if (!portCheck.ok) invalid(portCheck.message, ErrorCode.INVALID_RCON_PORT)
    if (!password) {
      invalid(
        'RCON password is required',
        ErrorCode.CONFIGURE_RCON_PASSWORD_REQUIRED,
      )
    }

    const iniPath = await requireIniPath()
    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, 'utf-8').replace(/\r\n/g, '\n')
      content = setIniKeyLine(
        content,
        'RCONPassword',
        sanitizeIniValue(password),
      )
      content = setIniKeyLine(content, 'RCONPort', portCheck.value)
      writeFileAtomic(iniPath, content, { encoding: 'utf-8', mode: 0o600 })
    })

    const { setSetting } = await database()
    const { resolveEnvRconHost } =
      await import('../../../panel-server/services/rcon.ts')
    await setSetting('rconPassword', password)
    await setSetting('rconPort', portCheck.value)
    await setSetting('rconHost', resolveEnvRconHost())
    return {
      success: true,
      message:
        'RCON configured successfully. Restart the server for changes to take effect.',
      iniPath,
    }
  },
)

export const configureNetwork = createServerAction(
  'server.configure',
  async (data) => {
    const portCheck = requireIntInRange(
      data.serverPort === undefined ? 16261 : data.serverPort,
      1024,
      65534,
      'Game port',
    )
    if (!portCheck.ok) invalid(portCheck.message, ErrorCode.INVALID_SERVER_PORT)
    const useUpnp = data.useUpnp === undefined ? true : data.useUpnp
    if (typeof useUpnp !== 'boolean') invalid('useUpnp must be a boolean')

    const iniPath = await requireIniPath()
    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, 'utf-8').replace(/\r\n/g, '\n')
      content = setIniKeyLine(content, 'DefaultPort', portCheck.value)
      content = setIniKeyLine(content, 'UDPPort', portCheck.value + 1)
      writeFileAtomic(iniPath, content, { encoding: 'utf-8', mode: 0o600 })
    })

    const { configPath, name } = await serverConfig()
    const { setSetting } = await database()
    await applyUpnpToIni(configPath!, name!, useUpnp)
    await setSetting('serverPort', portCheck.value)
    await setSetting('useUpnp', useUpnp)
    return {
      success: true,
      message:
        'Network settings configured successfully. Restart the server for changes to take effect.',
      iniPath,
      settings: {
        defaultPort: portCheck.value,
        udpPort: portCheck.value + 1,
        upnp: useUpnp,
      },
    }
  },
)

export const getServerUpdate = createServerRead(
  'server.world_events',
  async (data) => {
    const updateChecker = (await panelRuntime()).updateChecker
    if (!updateChecker) updateCheckerUnavailable()
    if (data.force === 'true' || data.force === true) {
      return (
        (await updateChecker.checkForUpdates(true)) || {
          error: 'Could not check for updates',
          code: ErrorCode.UPDATE_CHECK_NO_RESULT,
        }
      )
    }
    return updateChecker.getStatus()
  },
)

export const getServerUpdateStatus = createServerRead(
  'server.world_events',
  async () => {
    const updateChecker = (await panelRuntime()).updateChecker
    if (!updateChecker) updateCheckerUnavailable()
    return updateChecker.getStatus()
  },
)

export const dismissServerAutoUpdateResult = createServerAction(
  'server.world_events',
  async () => {
    const updateChecker = (await panelRuntime()).updateChecker
    if (!updateChecker) updateCheckerUnavailable()
    await updateChecker.dismissAutoUpdateResult()
    return updateChecker.getStatus()
  },
)

export const setServerUpdateInterval = createServerAction(
  'server.configure',
  async (data) => {
    const updateChecker = (await panelRuntime()).updateChecker
    if (!updateChecker) updateCheckerUnavailable()
    const minutes = data.minutes
    if (!minutes || typeof minutes !== 'number') {
      invalid(
        'minutes must be a number',
        ErrorCode.UPDATE_CHECK_INTERVAL_INVALID,
      )
    }
    await updateChecker.setInterval(minutes)
    return { success: true, intervalMinutes: minutes }
  },
)

let persistedVehicleCache: {
  key: string | null
  expiresAt: number
  vehicles: Array<{ id: number; x: number; y: number }>
} = { key: null, expiresAt: 0, vehicles: [] }

export const getMapVehicles = createServerRead(null, async () => {
  try {
    const { getActiveServer } = await database()
    const activeServer = await getActiveServer()
    if (
      !activeServer ||
      activeServer.isRemote ||
      !activeServer.zomboidDataPath
    ) {
      return { vehicles: [] }
    }
    const serverName = activeServer.serverName || activeServer.name
    if (!serverName) return { vehicles: [] }

    const savePath = path.join(
      activeServer.zomboidDataPath,
      'Saves',
      'Multiplayer',
      serverName,
    )
    const cacheKey = savePath
    if (
      persistedVehicleCache.key !== cacheKey ||
      Date.now() >= persistedVehicleCache.expiresAt
    ) {
      const { listPersistedVehicles } =
        await import('../../../panel-server/utils/vehiclesDb.ts')
      persistedVehicleCache = {
        key: cacheKey,
        expiresAt: Date.now() + 15_000,
        vehicles: await listPersistedVehicles(savePath),
      }
    }
    return { vehicles: persistedVehicleCache.vehicles }
  } catch {
    return { vehicles: [] }
  }
})
