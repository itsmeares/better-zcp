import { createServerFn } from '@tanstack/react-start'
import {
  anyPermissionMiddleware,
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth.server'
import type { SftpBridgeConfig } from '../../../panel-server/services/panelBridgeSftp.ts'

type AnyRecord = Record<string, any>

type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  params?: unknown
  status?: unknown
  data?: unknown
}

type BridgePath = {
  path: string
  source: string
  hasStatus: boolean
  hasInit: boolean
  exists: boolean
  priority: number
}

const SFTP_SETTING_KEYS = {
  enabled: 'panelBridgeSftpEnabled',
  host: 'panelBridgeSftpHost',
  port: 'panelBridgeSftpPort',
  username: 'panelBridgeSftpUsername',
  password: 'panelBridgeSftpPassword',
  bridgePath: 'panelBridgeSftpBridgePath',
  pollIntervalSeconds: 'panelBridgeSftpPollIntervalSeconds',
} as const

const SFTP_LOG_PATH_KEY = 'panelBridgeSftpLogPath'
const SFTP_CONFIG_PATH_KEY = 'panelBridgeSftpConfigPath'

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

function throwSetupError(error: unknown, fallbackStatus = 500): never {
  const details =
    error && typeof error === 'object' ? (error as ServiceError) : {}
  const status =
    typeof details.status === 'number' ? details.status : fallbackStatus
  throw Object.assign(new Error(errorMessage(error)), {
    status,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(details.params !== undefined ? { params: details.params } : {}),
    ...(details.data !== undefined ? { data: details.data } : {}),
  })
}

function invalid(message: string, code?: string, params?: unknown): never {
  throwSetupError(
    Object.assign(new Error(message), {
      ...(code ? { code } : {}),
      ...(params !== undefined ? { params } : {}),
    }),
    400,
  )
}

function setupMiddleware() {
  return [
    ...protectedServerFunctionMiddleware,
    permissionMiddleware('bridge.setup'),
  ] as const
}

function argsFor(data: AnyRecord): AnyRecord {
  if (
    data.args !== undefined &&
    (typeof data.args !== 'object' ||
      data.args === null ||
      Array.isArray(data.args))
  ) {
    invalid('args must be an object', 'PANELBRIDGE_ARGS_MUST_BE_OBJECT')
  }
  return record(data.args)
}

async function throwSanitized(
  error: unknown,
  status = 500,
  extra: AnyRecord = {},
): Promise<never> {
  const { sanitizeError } =
    await import('../../../panel-server/utils/sanitize.ts')
  throwSetupError(
    Object.assign(new Error(sanitizeError(errorMessage(error))), {
      status,
      ...extra,
    }),
    status,
  )
}

async function throwSftpError(error: unknown): Promise<never> {
  const [
    { sanitizeError, sanitizeErrorParams },
    { classifySftpErrorCode, formatSftpError },
  ] = await Promise.all([
    import('../../../panel-server/utils/sanitize.ts'),
    import('../../../panel-server/services/panelBridgeSftp.ts'),
  ])
  throwSetupError(
    Object.assign(new Error(sanitizeError(formatSftpError(error))), {
      status: 400,
      code: classifySftpErrorCode(error),
      params: sanitizeErrorParams({ detail: errorMessage(error) }),
    }),
    400,
  )
}

async function panelBridge(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime().panelBridge as AnyRecord
}

function isValidBridgePath(
  inputPath: unknown,
  pathModule: AnyRecord,
): inputPath is string {
  if (!inputPath || typeof inputPath !== 'string') return false
  if (!pathModule.isAbsolute(inputPath)) return false
  const resolved = pathModule.resolve(inputPath)
  const blockedPrefixes =
    process.platform === 'win32'
      ? ['c:\\windows', 'c:\\program files']
      : ['/etc', '/usr', '/bin', '/sbin', '/proc', '/sys', '/dev']
  const lower = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  return !blockedPrefixes.some((prefix) => lower.startsWith(prefix))
}

async function getStatus(): Promise<AnyRecord> {
  const bridge = await panelBridge()
  const status = bridge.getStatus() as AnyRecord
  let detectedPaths: AnyRecord | null = null
  let localInstall: AnyRecord | null = null
  let remoteBridgeVersionCheck: AnyRecord | null = null

  try {
    const { getActiveServer } =
      await import('../../../panel-server/database/init.ts')
    const activeServer = await getActiveServer()
    if (activeServer) {
      detectedPaths = {
        serverName: activeServer.serverName || activeServer.name,
        installPath: activeServer.installPath,
        zomboidDataPath: activeServer.zomboidDataPath,
      }
      const {
        canAutoInstall,
        checkBridgeInstalled,
        getBundledBridgeVersion,
        isBridgeVersionBehindBundled,
      } = await import('../../../panel-server/services/panelBridgeInstaller.ts')
      if (activeServer.isRemote) {
        const bundledVersion = getBundledBridgeVersion()
        const liveVersion = status.version || null
        remoteBridgeVersionCheck = {
          bundledVersion,
          liveVersion,
          behind: liveVersion
            ? isBridgeVersionBehindBundled(liveVersion)
            : null,
        }
      } else {
        localInstall = {
          canAutoInstall: canAutoInstall(activeServer),
          ...checkBridgeInstalled(activeServer),
        }
      }
    }
  } catch {
    // Status should still be useful when optional install metadata is unavailable.
  }

  return {
    ...status,
    modConnected: bridge.isModConnected(),
    detectedPaths,
    localInstall,
    remoteBridgeVersionCheck,
  }
}

async function autoConfigureBridge(
  args: AnyRecord,
  errorCodes: AnyRecord,
): Promise<AnyRecord> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const os = await import('node:os')
  const [
    { getActiveServer, getServer },
    { getEmbeddedPanelBridgeLua, compareModVersions, writeLuaAtomic },
    { resolveInstallDir, resolveSourcePath },
  ] = await Promise.all([
    import('../../../panel-server/database/init.ts'),
    import('../../../panel-server/utils/embeddedLua.ts'),
    import('../../../panel-server/services/panelBridgeInstaller.ts'),
  ])

  try {
    const serverId = args.serverId
    let targetServer: AnyRecord | null
    if (serverId) {
      targetServer = await getServer(serverId)
      if (!targetServer) {
        throwSetupError(
          Object.assign(new Error(`Server with ID ${serverId} not found.`), {
            status: 400,
            code: errorCodes.PANELBRIDGE_SERVER_ID_NOT_FOUND,
          }),
          400,
        )
      }
    } else {
      targetServer = await getActiveServer()
      if (!targetServer) {
        throwSetupError(
          Object.assign(
            new Error(
              'No active server configured. Please configure a server first.',
            ),
            {
              status: 400,
              code: errorCodes.PANELBRIDGE_AUTO_CONFIGURE_NO_ACTIVE_SERVER,
            },
          ),
          400,
        )
      }
    }

    const serverName = targetServer.serverName || targetServer.name
    if (!serverName) {
      throwSetupError(
        Object.assign(new Error('Server name not configured.'), {
          status: 400,
          code: errorCodes.PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED,
        }),
        400,
      )
    }

    const possiblePaths: BridgePath[] = []
    const searchedLocations: AnyRecord[] = []
    const safeReadDir = (dirPath: string): string[] => {
      try {
        return fs.readdirSync(dirPath)
      } catch {
        return []
      }
    }
    const addPath = (bridgePath: string, source: string, priority = 10) => {
      if (possiblePaths.some((entry) => entry.path === bridgePath)) return
      const statusFile = path.join(bridgePath, 'status.json')
      const initFile = path.join(bridgePath, '.init')
      const hasStatus = fs.existsSync(statusFile)
      const hasInit = fs.existsSync(initFile)
      possiblePaths.push({
        path: bridgePath,
        source,
        hasStatus,
        hasInit,
        exists: hasStatus || hasInit || fs.existsSync(bridgePath),
        priority,
      })
      searchedLocations.push({ path: bridgePath, source, hasStatus, hasInit })
    }

    if (targetServer.zomboidDataPath) {
      addPath(
        path.join(
          targetServer.zomboidDataPath,
          'Lua',
          'panelbridge',
          serverName,
        ),
        'zomboidDataPath/Lua (cachedir)',
        1,
      )
    }
    addPath(
      path.join(os.homedir(), 'Zomboid', 'Lua', 'panelbridge', serverName),
      'default Zomboid folder',
      2,
    )

    if (targetServer.installPath) {
      const parentDir = path.dirname(targetServer.installPath)
      for (const item of safeReadDir(parentDir)) {
        if (item.startsWith('Server_files') || /Server.*files/i.test(item)) {
          addPath(
            path.join(parentDir, item, 'Lua', 'panelbridge', serverName),
            `${item}/Lua`,
            3,
          )
        }
      }

      const grandParentDir = path.dirname(parentDir)
      if (grandParentDir !== parentDir) {
        for (const item of safeReadDir(grandParentDir)) {
          if (item.startsWith('Server_files') || /Server.*files/i.test(item)) {
            addPath(
              path.join(grandParentDir, item, 'Lua', 'panelbridge', serverName),
              `${item}/Lua`,
              4,
            )
          }
        }
      }
      addPath(
        path.join(targetServer.installPath, 'Lua', 'panelbridge', serverName),
        'installPath/Lua',
        5,
      )
    }

    possiblePaths.sort((a, b) => {
      if (a.hasStatus && !b.hasStatus) return -1
      if (!a.hasStatus && b.hasStatus) return 1
      if (a.hasInit && !b.hasInit) return -1
      if (!a.hasInit && b.hasInit) return 1
      return a.priority - b.priority
    })
    const foundPath =
      possiblePaths.find((entry) => entry.hasStatus) ??
      possiblePaths.find((entry) => entry.hasInit) ??
      possiblePaths.find((entry) => entry.exists) ??
      possiblePaths[0]

    if (!foundPath) {
      throwSetupError(
        Object.assign(
          new Error(
            `Could not determine bridge path for server "${serverName}". Make sure server installPath is set.`,
          ),
          {
            status: 400,
            code: errorCodes.PANELBRIDGE_PATH_NOT_DETERMINED,
            data: { searchedPaths: searchedLocations },
          },
        ),
        400,
      )
    }

    const bridge = await panelBridge()
    if (bridge.isRunning) bridge.stop()
    bridge.configure(foundPath.path, true)
    bridge.start()

    let modInstalled = false
    let modUpdated = false
    try {
      const installDir = resolveInstallDir(targetServer)
      if (installDir) {
        const destination = path.join(
          installDir,
          'media',
          'lua',
          'server',
          'PanelBridge.lua',
        )
        let sourceContent = getEmbeddedPanelBridgeLua()
        if (!sourceContent) {
          const sourcePath = resolveSourcePath()
          if (sourcePath) {
            try {
              sourceContent = fs.readFileSync(sourcePath, 'utf8')
            } catch {
              sourceContent = null
            }
          }
        }
        if (sourceContent) {
          let destinationContent: string | null = null
          try {
            const fd = fs.openSync(destination, 'r')
            try {
              destinationContent = fs.readFileSync(fd, 'utf8')
            } finally {
              fs.closeSync(fd)
            }
          } catch {
            // A missing or unreadable destination is repaired below.
          }
          let needsCopy = destinationContent === null
          if (destinationContent !== null) {
            modInstalled = true
            try {
              const sourceVersion = (sourceContent.match(
                /VERSION\s*=\s*"([^"]+)"/,
              ) || [])[1]
              const destinationVersion = (destinationContent.match(
                /VERSION\s*=\s*"([^"]+)"/,
              ) || [])[1]
              if (
                sourceVersion &&
                destinationVersion &&
                compareModVersions(sourceVersion, destinationVersion) > 0
              ) {
                needsCopy = true
                modUpdated = true
              }
            } catch {
              // Keep the existing mod when its version cannot be read.
            }
          }
          if (needsCopy) {
            writeLuaAtomic(destination, sourceContent)
            modInstalled = true
          }
        }
      }
    } catch {
      // Bridge setup still succeeds when optional local mod installation fails.
    }

    return {
      success: true,
      message: `Bridge auto-configured from server: ${targetServer.name}`,
      bridgePath: foundPath.path,
      serverName,
      source: foundPath.source,
      hasStatus: foundPath.hasStatus,
      modInstalled,
      modUpdated,
      searchedPaths: searchedLocations,
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as { status?: unknown }).status === 'number'
    ) {
      throw error
    }
    return throwSanitized(error, 500)
  }
}

async function scanServerBridge(
  args: AnyRecord,
  errorCodes: AnyRecord,
): Promise<AnyRecord> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const os = await import('node:os')
  const { getServer } = await import('../../../panel-server/database/init.ts')
  const serverId = args.serverId
  try {
    const targetServer = await getServer(serverId)
    if (!targetServer) {
      throwSetupError(
        Object.assign(new Error(`Server with ID ${serverId} not found.`), {
          status: 404,
          code: errorCodes.PANELBRIDGE_SERVER_ID_NOT_FOUND,
        }),
        404,
      )
    }
    const serverName = targetServer.serverName || targetServer.name
    if (!serverName) {
      throwSetupError(
        Object.assign(new Error('Server name not configured.'), {
          status: 400,
          code: errorCodes.PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED,
        }),
        400,
      )
    }

    const possiblePaths: BridgePath[] = []
    const safeReadDir = (dirPath: string): string[] => {
      try {
        return fs.readdirSync(dirPath)
      } catch {
        return []
      }
    }
    const addPath = (bridgePath: string, source: string, priority = 10) => {
      if (possiblePaths.some((entry) => entry.path === bridgePath)) return
      const statusFile = path.join(bridgePath, 'status.json')
      const initFile = path.join(bridgePath, '.init')
      const hasStatus = fs.existsSync(statusFile)
      const hasInit = fs.existsSync(initFile)
      possiblePaths.push({
        path: bridgePath,
        source,
        hasStatus,
        hasInit,
        exists: hasStatus || hasInit || fs.existsSync(bridgePath),
        priority,
      })
    }

    addPath(
      path.join(os.homedir(), 'Zomboid', 'Lua', 'panelbridge', serverName),
      'default Zomboid folder',
      0,
    )
    if (targetServer.installPath) {
      const parentDir = path.dirname(targetServer.installPath)
      for (const item of safeReadDir(parentDir)) {
        if (item.startsWith('Server_files') || /Server.*files/i.test(item)) {
          addPath(
            path.join(parentDir, item, 'Lua', 'panelbridge', serverName),
            item,
            1,
          )
        }
      }
      const grandParentDir = path.dirname(parentDir)
      if (grandParentDir !== parentDir) {
        for (const item of safeReadDir(grandParentDir)) {
          if (item.startsWith('Server_files') || /Server.*files/i.test(item)) {
            addPath(
              path.join(grandParentDir, item, 'Lua', 'panelbridge', serverName),
              `${item} (grandparent)`,
              2,
            )
          }
        }
      }
      addPath(
        path.join(targetServer.installPath, 'Lua', 'panelbridge', serverName),
        'installPath/Lua',
        3,
      )
      addPath(
        path.join(parentDir, 'Lua', 'panelbridge', serverName),
        'parent/Lua',
        4,
      )
    }
    if (targetServer.zomboidDataPath) {
      addPath(
        path.join(
          targetServer.zomboidDataPath,
          'Lua',
          'panelbridge',
          serverName,
        ),
        'zomboidDataPath',
        1,
      )
    }

    possiblePaths.sort((a, b) => {
      if (a.hasStatus && !b.hasStatus) return -1
      if (!a.hasStatus && b.hasStatus) return 1
      if (a.hasInit && !b.hasInit) return -1
      if (!a.hasInit && b.hasInit) return 1
      return a.priority - b.priority
    })
    const recommendedPath =
      possiblePaths.find((entry) => entry.hasStatus) ??
      possiblePaths.find((entry) => entry.hasInit) ??
      possiblePaths[0] ??
      null
    return {
      success: true,
      serverName,
      serverId: targetServer.id,
      paths: possiblePaths,
      recommendedPath: recommendedPath?.path || null,
      recommendedSource: recommendedPath?.source || null,
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as { status?: unknown }).status === 'number'
    ) {
      throw error
    }
    return throwSanitized(error, 500)
  }
}

async function autoDetectBridge(
  args: AnyRecord,
  errorCodes: AnyRecord,
): Promise<AnyRecord> {
  const path = await import('node:path')
  const serverName = args.serverName
  const zomboidUserFolder = args.zomboidUserFolder
  if (!serverName) {
    invalid(
      'serverName is required',
      errorCodes.PANELBRIDGE_SERVER_NAME_REQUIRED,
    )
  }
  if (zomboidUserFolder && !isValidBridgePath(zomboidUserFolder, path)) {
    invalid(
      'Invalid zomboidUserFolder path',
      errorCodes.PANELBRIDGE_INVALID_ZOMBOID_USER_FOLDER,
    )
  }
  try {
    const bridge = await panelBridge()
    await bridge.stopSftp()
    if (bridge.isRunning) bridge.stop()
    const bridgePath = bridge.autoDetect(serverName, zomboidUserFolder)
    bridge.start()
    return {
      success: true,
      message: 'Bridge auto-configured and started',
      bridgePath,
    }
  } catch (error) {
    return throwSanitized(error, 400)
  }
}

async function configureBridge(
  args: AnyRecord,
  errorCodes: AnyRecord,
): Promise<AnyRecord> {
  const path = await import('node:path')
  const zomboidSavePath = args.zomboidSavePath
  if (!zomboidSavePath) {
    invalid(
      'zomboidSavePath is required',
      errorCodes.PANELBRIDGE_SAVE_PATH_REQUIRED,
    )
  }
  if (!isValidBridgePath(zomboidSavePath, path)) {
    invalid('Invalid zomboidSavePath', errorCodes.PANELBRIDGE_INVALID_SAVE_PATH)
  }
  try {
    const bridge = await panelBridge()
    await bridge.stopSftp()
    if (bridge.isRunning) bridge.stop()
    const bridgePath = bridge.configure(zomboidSavePath)
    bridge.start()
    const { setSetting } =
      await import('../../../panel-server/database/init.ts')
    await setSetting('panelBridge', { bridgePath })
    return {
      success: true,
      message: 'Bridge configured and started',
      bridgePath,
    }
  } catch (error) {
    return throwSanitized(error, 500)
  }
}

async function configureDirectBridge(
  args: AnyRecord,
  errorCodes: AnyRecord,
): Promise<AnyRecord> {
  const path = await import('node:path')
  const reqPath = args.bridgePath
  if (!reqPath || typeof reqPath !== 'string') {
    invalid(
      'bridgePath is required',
      errorCodes.PANELBRIDGE_BRIDGE_PATH_REQUIRED,
    )
  }
  if (!path.isAbsolute(reqPath)) {
    invalid(
      'Path must be absolute',
      errorCodes.PANELBRIDGE_PATH_MUST_BE_ABSOLUTE,
    )
  }
  const resolved = path.resolve(reqPath)
  if (!isValidBridgePath(resolved, path)) {
    invalid(
      'Path targets a protected system directory',
      errorCodes.PANELBRIDGE_PATH_PROTECTED_SYSTEM_DIR,
    )
  }
  try {
    const bridge = await panelBridge()
    await bridge.stopSftp()
    if (bridge.isRunning) bridge.stop()
    const configuredPath = bridge.configure(resolved, true)
    bridge.start()
    const { setSetting } =
      await import('../../../panel-server/database/init.ts')
    await setSetting('panelBridge', { bridgePath: configuredPath })
    return {
      success: true,
      message: 'Bridge configured with manual path and started',
      bridgePath: configuredPath,
    }
  } catch (error) {
    return throwSanitized(error, 500)
  }
}

async function resolveSftpConfig(
  input: AnyRecord = {},
): Promise<SftpBridgeConfig> {
  const [{ getAllSettings }, { isMaskedSecret }, { validateSftpBridgeConfig }] =
    await Promise.all([
      import('../../../panel-server/database/init.ts'),
      import('../../../panel-server/utils/sanitize.ts'),
      import('../../../panel-server/services/panelBridgeSftp.ts'),
    ])
  const settings = (await getAllSettings()) as AnyRecord
  const password =
    input.password && !isMaskedSecret(input.password)
      ? input.password
      : settings[SFTP_SETTING_KEYS.password] || ''
  return validateSftpBridgeConfig({
    host: input.host ?? settings[SFTP_SETTING_KEYS.host],
    port: input.port ?? settings[SFTP_SETTING_KEYS.port],
    username: input.username ?? settings[SFTP_SETTING_KEYS.username],
    password,
    bridgePath: input.bridgePath ?? settings[SFTP_SETTING_KEYS.bridgePath],
    pollIntervalSeconds:
      input.pollIntervalSeconds ??
      settings[SFTP_SETTING_KEYS.pollIntervalSeconds],
  })
}

async function resolveSftpLogConfig(input: AnyRecord = {}): Promise<AnyRecord> {
  const [{ getAllSettings }, { isMaskedSecret }] = await Promise.all([
    import('../../../panel-server/database/init.ts'),
    import('../../../panel-server/utils/sanitize.ts'),
  ])
  const settings = (await getAllSettings()) as AnyRecord
  const password =
    input.password && !isMaskedSecret(input.password)
      ? input.password
      : settings[SFTP_SETTING_KEYS.password] || ''
  return {
    host: input.host ?? settings[SFTP_SETTING_KEYS.host],
    port: input.port ?? settings[SFTP_SETTING_KEYS.port],
    username: input.username ?? settings[SFTP_SETTING_KEYS.username],
    password,
    logPath: input.logPath ?? settings[SFTP_LOG_PATH_KEY],
  }
}

async function configureSftpBridge(args: AnyRecord): Promise<AnyRecord> {
  try {
    const config = await resolveSftpConfig(args)
    const [{ getSftpCachePath }, bridge, { setSetting }] = await Promise.all([
      import('../../../panel-server/services/panelBridgeSftp.ts'),
      panelBridge(),
      import('../../../panel-server/database/init.ts'),
    ])
    const cachePath = getSftpCachePath(
      config.host,
      config.port,
      config.username,
      config.bridgePath,
    )
    await bridge.configureSftp(config, cachePath)
    for (const [field, key] of Object.entries(SFTP_SETTING_KEYS)) {
      const value = field === 'enabled' ? true : (config as AnyRecord)[field]
      if (value !== undefined) await setSetting(key, value)
    }
    return {
      success: true,
      bridgePath: cachePath,
      transport: bridge.getStatus().transport,
    }
  } catch (error) {
    return throwSftpError(error)
  }
}

async function testSftpBridge(args: AnyRecord): Promise<AnyRecord> {
  try {
    const { testSftpBridge } =
      await import('../../../panel-server/services/panelBridgeSftp.ts')
    return await testSftpBridge(await resolveSftpConfig(args))
  } catch (error) {
    return throwSftpError(error)
  }
}

async function listSftpLogsBridge(args: AnyRecord): Promise<AnyRecord> {
  try {
    const [{ listSftpLogs }, { setSetting }] = await Promise.all([
      import('../../../panel-server/services/panelBridgeSftp.ts'),
      import('../../../panel-server/database/init.ts'),
    ])
    const config = await resolveSftpLogConfig(args)
    const result = await listSftpLogs(config)
    if (args.logPath) await setSetting(SFTP_LOG_PATH_KEY, config.logPath)
    return { success: true, ...result }
  } catch (error) {
    return throwSanitized(error, 400)
  }
}

async function tailSftpLogBridge(args: AnyRecord): Promise<AnyRecord> {
  try {
    const { readSftpLogTail } =
      await import('../../../panel-server/services/panelBridgeSftp.ts')
    const config = await resolveSftpLogConfig(args)
    const result = await readSftpLogTail(config, args.name, args.maxBytes)
    return { success: true, ...result }
  } catch (error) {
    return throwSanitized(error, 400)
  }
}

async function listRemoteConfigBridge(args: AnyRecord): Promise<AnyRecord> {
  try {
    const [
      { getAllSettings, setSetting },
      { isMaskedSecret },
      {
        listRemoteConfigFiles,
        resetRemoteConfigSession,
        validateRemoteConfigTransport,
      },
    ] = await Promise.all([
      import('../../../panel-server/database/init.ts'),
      import('../../../panel-server/utils/sanitize.ts'),
      import('../../../panel-server/services/remoteConfigFiles.ts'),
    ])
    const settings = (await getAllSettings()) as AnyRecord
    const password =
      args.password && !isMaskedSecret(args.password)
        ? args.password
        : settings[SFTP_SETTING_KEYS.password] || ''
    const config = validateRemoteConfigTransport({
      host: args.host ?? settings[SFTP_SETTING_KEYS.host],
      port: args.port ?? settings[SFTP_SETTING_KEYS.port],
      username: args.username ?? settings[SFTP_SETTING_KEYS.username],
      password,
      configPath: args.configPath ?? settings[SFTP_CONFIG_PATH_KEY],
    })
    const result = await listRemoteConfigFiles(config)
    if (args.configPath) {
      await setSetting(SFTP_CONFIG_PATH_KEY, config.configPath)
      resetRemoteConfigSession()
    }
    return { success: true, ...result }
  } catch (error) {
    return throwSanitized(error, 400)
  }
}

async function scanBridgePaths(): Promise<AnyRecord> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const bridge = await panelBridge()
  try {
    const { getActiveServer } =
      await import('../../../panel-server/database/init.ts')
    const activeServer = await getActiveServer()
    const foundBridges: AnyRecord[] = []
    const scannedDirs: string[] = []

    const searchForBridge = (baseDir: string, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth || !baseDir) return
      try {
        const contents = fs.readdirSync(baseDir, { withFileTypes: true })
        for (const item of contents) {
          if (!item.isDirectory()) continue
          const itemPath = path.join(baseDir, item.name)
          if (item.name === 'panelbridge') {
            try {
              const serverFolders = fs.readdirSync(itemPath, {
                withFileTypes: true,
              })
              for (const serverFolder of serverFolders) {
                if (!serverFolder.isDirectory()) continue
                const serverPath = path.join(itemPath, serverFolder.name)
                const statusFile = path.join(serverPath, 'status.json')
                const initFile = path.join(serverPath, '.init')
                const hasInit = fs.existsSync(initFile)
                let hasStatus = false
                let statusAge: number | null = null
                let modVersion: string | null = null
                try {
                  const fd = fs.openSync(statusFile, 'r')
                  try {
                    hasStatus = true
                    statusAge = Date.now() - fs.fstatSync(fd).mtimeMs
                    modVersion = JSON.parse(fs.readFileSync(fd, 'utf8')).version
                  } finally {
                    fs.closeSync(fd)
                  }
                } catch {
                  // A missing or partially written status file is not fatal to scanning.
                }
                foundBridges.push({
                  path: serverPath,
                  serverName: serverFolder.name,
                  baseDir,
                  hasStatus,
                  hasInit,
                  statusAge,
                  modVersion,
                  isActive: statusAge !== null && statusAge < 60000,
                })
              }
            } catch {
              // Ignore folders that disappear or become unreadable during a scan.
            }
            continue
          }
          if (item.name === 'Lua') {
            const bridgePath = path.join(itemPath, 'panelbridge')
            scannedDirs.push(bridgePath)
            searchForBridge(bridgePath, depth + 1, maxDepth)
            continue
          }
          if (
            item.name.startsWith('Server_files') ||
            /Server.*files/i.test(item.name)
          ) {
            scannedDirs.push(itemPath)
            searchForBridge(itemPath, depth + 1, maxDepth)
          }
        }
      } catch {
        // Ignore unreadable directories.
      }
    }

    const searchDirs = new Set<string>()
    if (activeServer?.installPath) {
      searchDirs.add(activeServer.installPath)
      searchDirs.add(path.dirname(activeServer.installPath))
    }
    if (activeServer?.zomboidDataPath) {
      searchDirs.add(activeServer.zomboidDataPath)
      searchDirs.add(path.dirname(activeServer.zomboidDataPath))
    }
    if (bridge.bridgePath) {
      const parts = bridge.bridgePath.split(path.sep)
      const panelbridgeIndex = parts.indexOf('panelbridge')
      if (panelbridgeIndex > 0) {
        searchDirs.add(parts.slice(0, panelbridgeIndex).join(path.sep))
      }
    }
    for (const directory of searchDirs) {
      if (!directory) continue
      scannedDirs.push(directory)
      searchForBridge(directory)
    }

    return {
      foundBridges,
      scannedDirs: [...new Set(scannedDirs)],
      currentPath: bridge.bridgePath,
      isRunning: bridge.isRunning,
      modConnected: bridge.isModConnected(),
    }
  } catch (error) {
    return throwSanitized(error, 500)
  }
}

async function getModPathBridge(): Promise<AnyRecord> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { resolveSourcePath } =
    await import('../../../panel-server/services/panelBridgeInstaller.ts')
  const sourcePath = resolveSourcePath()
  const candidates: string[] = []
  if (sourcePath) {
    candidates.push(
      path.join(path.dirname(sourcePath), '..', '..', '..'),
    )
  }
  candidates.push(
    path.join(process.cwd(), 'integrations', 'panelbridge', 'PanelBridge'),
    path.join(path.dirname(process.execPath), 'pz-mod', 'PanelBridge'),
    path.join(process.cwd(), 'pz-mod', 'PanelBridge'),
  )
  let modPath = candidates[0]
  let exists = false
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    modPath = candidate
    exists = true
    break
  }
  let suggestedInstallPath: string | null = null
  try {
    const { getActiveServer } =
      await import('../../../panel-server/database/init.ts')
    const activeServer = await getActiveServer()
    if (activeServer?.installPath) {
      suggestedInstallPath = path.join(
        activeServer.installPath,
        'media',
        'lua',
        'server',
      )
    }
  } catch {
    // Optional metadata should not make the source lookup fail.
  }
  return {
    modPath,
    exists,
    files: exists ? fs.readdirSync(modPath) : [],
    suggestedInstallPath,
  }
}

async function installLocalBridge(errorCodes: AnyRecord): Promise<AnyRecord> {
  try {
    const { getActiveServer } =
      await import('../../../panel-server/database/init.ts')
    const { canAutoInstall, installBridge } =
      await import('../../../panel-server/services/panelBridgeInstaller.ts')
    const server = await getActiveServer()
    if (!server) {
      throwSetupError(
        Object.assign(new Error('No active server configured.'), {
          status: 400,
          code: errorCodes.PANELBRIDGE_NO_ACTIVE_SERVER,
          success: false,
        }),
        400,
      )
    }
    if (!canAutoInstall(server)) {
      throwSetupError(
        Object.assign(
          new Error(
            'Auto-install is not available for this server. It must be a local (non-remote) server with a writable install path and the PanelBridge source present.',
          ),
          {
            status: 400,
            code: errorCodes.PANELBRIDGE_AUTO_INSTALL_NOT_AVAILABLE,
            success: false,
          },
        ),
        400,
      )
    }
    const result = installBridge(server)
    if (!result.success) {
      throwSetupError(Object.assign(new Error(result.error), { status: 500 }), 500)
    }
    return {
      ...result,
      message: `PanelBridge installed to ${result.targetPath}`,
      serverName: server.serverName || server.name,
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as { status?: unknown }).status === 'number'
    ) {
      throw error
    }
    return throwSanitized(error, 500)
  }
}

async function installModBridge(
  args: AnyRecord,
  errorCodes: AnyRecord,
): Promise<AnyRecord> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const targetPath = args.serverLuaPath || args.serverModsPath
  if (!targetPath) {
    invalid(
      'serverLuaPath is required (path to media/lua/server/)',
      errorCodes.PANELBRIDGE_SERVER_LUA_PATH_REQUIRED,
    )
  }
  if (typeof targetPath !== 'string' || targetPath.length > 500) {
    invalid(
      'Invalid path format',
      errorCodes.PANELBRIDGE_SERVER_LUA_PATH_FORMAT_INVALID,
    )
  }
  if (!path.isAbsolute(targetPath)) {
    invalid(
      'Must be an absolute path',
      errorCodes.PANELBRIDGE_SERVER_LUA_PATH_NOT_ABSOLUTE,
    )
  }

  const resolvedTarget = path.resolve(targetPath)
  const normalizedTarget = resolvedTarget.replace(/\\/g, '/')
  if (!normalizedTarget.toLowerCase().endsWith('/media/lua/server')) {
    invalid(
      'Path must point to a media/lua/server/ directory',
      errorCodes.PANELBRIDGE_SERVER_LUA_PATH_WRONG_DIRECTORY,
    )
  }

  let allowedTarget: string | null = null
  try {
    const [{ getServers }, { resolveInstallDir }] = await Promise.all([
      import('../../../panel-server/database/init.ts'),
      import('../../../panel-server/services/panelBridgeInstaller.ts'),
    ])
    const normalise = (value: string) => {
      const resolved = path.resolve(value)
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved
    }
    for (const server of await getServers()) {
      if (server?.isRemote) continue
      const installDir = resolveInstallDir(server)
      if (!installDir || !path.isAbsolute(installDir)) continue
      let canonicalInstallDir: string
      try {
        canonicalInstallDir = fs.realpathSync(installDir)
      } catch {
        continue
      }
      const candidate = path.join(canonicalInstallDir, 'media', 'lua', 'server')
      if (normalise(candidate) === normalise(resolvedTarget)) {
        allowedTarget = candidate
        break
      }
    }
  } catch {
    // A path is never accepted when the configured-server allowlist cannot be read.
  }
  if (!allowedTarget) {
    invalid(
      'Path must match the media/lua/server directory of a configured local server',
      errorCodes.PANELBRIDGE_SERVER_LUA_PATH_NOT_CONFIGURED,
    )
  }

  const [{ getEmbeddedPanelBridgeLua, writeLuaAtomic }, { resolveSourcePath }] =
    await Promise.all([
      import('../../../panel-server/utils/embeddedLua.ts'),
      import('../../../panel-server/services/panelBridgeInstaller.ts'),
    ])
  let sourceContent = getEmbeddedPanelBridgeLua()
  if (!sourceContent) {
    const sourcePath = resolveSourcePath()
    if (sourcePath) sourceContent = fs.readFileSync(sourcePath, 'utf8')
  }
  if (!sourceContent) {
    throwSetupError(
      Object.assign(
        new Error('Source mod not found (no embedded Lua and no on-disk pz-mod).'),
        { status: 404, code: errorCodes.PANELBRIDGE_SOURCE_MOD_NOT_FOUND },
      ),
      404,
    )
  }
  fs.mkdirSync(allowedTarget, { recursive: true, mode: 0o755 })
  const destination = path.join(allowedTarget, 'PanelBridge.lua')
  writeLuaAtomic(destination, sourceContent)
  return {
    success: true,
    message: 'PanelBridge.lua installed successfully',
    path: destination,
  }
}

async function installModAutomatically(
  args: AnyRecord,
  errorCodes: AnyRecord,
): Promise<AnyRecord> {
  try {
    const { getActiveServer, getServer } =
      await import('../../../panel-server/database/init.ts')
    const { canAutoInstall, installBridge } =
      await import('../../../panel-server/services/panelBridgeInstaller.ts')
    const serverId = args.serverId
    const targetServer = serverId
      ? await getServer(serverId)
      : await getActiveServer()
    if (!targetServer) {
      throwSetupError(
        Object.assign(
          new Error(
            serverId
              ? `Server with ID ${serverId} not found.`
              : 'No active server configured.',
          ),
          {
            status: 400,
            code: serverId
              ? errorCodes.PANELBRIDGE_SERVER_ID_NOT_FOUND
              : errorCodes.PANELBRIDGE_NO_ACTIVE_SERVER,
          },
        ),
        400,
      )
    }
    if (targetServer.isRemote) {
      invalid(
        "Automatic PanelBridge installation is unavailable for remote servers. Copy PanelBridge.lua to the remote server's Lua folder using SFTP or the hosting provider's file manager.",
        errorCodes.PANELBRIDGE_INSTALL_REMOTE_NOT_AVAILABLE,
      )
    }
    if (!canAutoInstall(targetServer)) {
      invalid(
        'Automatic PanelBridge installation is unavailable. Configure an existing local server install folder with write permission, or use the manual install path.',
        errorCodes.PANELBRIDGE_INSTALL_CANNOT_AUTO_INSTALL,
      )
    }
    const result = installBridge(targetServer)
    if (!result.success) {
      throwSetupError(
        Object.assign(
          new Error(result.error || 'PanelBridge installation failed.'),
          {
            status: 500,
          },
        ),
        500,
      )
    }
    return {
      ...result,
      message:
        result.message || `PanelBridge installed to ${result.targetPath}`,
      serverName: targetServer.serverName || targetServer.name,
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as { status?: unknown }).status === 'number'
    ) {
      throw error
    }
    return throwSanitized(error, 500)
  }
}

async function executeSetupAction(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } =
    await import('../../../panel-server/utils/errorCodes.ts')
  const action = data.action
  if (typeof action !== 'string' || !action) {
    invalid('action is required', ErrorCode.PANELBRIDGE_ACTION_REQUIRED)
  }
  const args = argsFor(data)
  switch (action) {
    case 'autoConfigure':
      return autoConfigureBridge(args, ErrorCode)
    case 'scanServer':
      return scanServerBridge(args, ErrorCode)
    case 'autoDetect':
      return autoDetectBridge(args, ErrorCode)
    case 'configure':
      return configureBridge(args, ErrorCode)
    case 'configureDirect':
      return configureDirectBridge(args, ErrorCode)
    case 'configureSftp':
      return configureSftpBridge(args)
    case 'testSftp':
      return testSftpBridge(args)
    case 'listSftpLogs':
      return listSftpLogsBridge(args)
    case 'tailSftpLog':
      return tailSftpLogBridge(args)
    case 'listRemoteConfig':
      return listRemoteConfigBridge(args)
    case 'start': {
      try {
        const bridge = await panelBridge()
        bridge.start()
        return { success: true, message: 'Bridge started' }
      } catch (error) {
        return throwSanitized(error, 500)
      }
    }
    case 'stop': {
      try {
        const bridge = await panelBridge()
        await bridge.stopSftp()
        bridge.stop()
        return { success: true, message: 'Bridge stopped' }
      } catch (error) {
        return throwSanitized(error, 500)
      }
    }
    case 'refresh': {
      try {
        const bridge = await panelBridge()
        if (bridge.isRunning) bridge.stop()
        if (bridge.bridgePath) {
          bridge.start()
          return {
            success: true,
            message: 'Bridge refreshed',
            bridgePath: bridge.bridgePath,
          }
        }
        return {
          success: false,
          message: 'Bridge not configured - use auto-configure first',
        }
      } catch (error) {
        return throwSanitized(error, 500)
      }
    }
    case 'scanPaths':
      return scanBridgePaths()
    case 'getModPath':
      return getModPathBridge()
    case 'installLocal':
      return installLocalBridge(ErrorCode)
    case 'installMod':
      return installModBridge(args, ErrorCode)
    case 'installModAuto':
      return installModAutomatically(args, ErrorCode)
    default:
      invalid('Unknown or invalid action', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }
}

async function ping(): Promise<unknown> {
  const bridge = await panelBridge()
  const { ErrorCode } =
    await import('../../../panel-server/utils/errorCodes.ts')
  if (!bridge.bridgePath)
    invalid('Bridge not configured', ErrorCode.BRIDGE_NOT_CONFIGURED)
  try {
    return await bridge.ping()
  } catch (error) {
    return throwSanitized(error, 500)
  }
}

export const getPanelBridgeStatus = createServerFn({ method: 'GET' })
  .middleware([
    ...protectedServerFunctionMiddleware,
    anyPermissionMiddleware('bridge.setup', 'bridge.diagnostics'),
  ] as const)
  .handler(getStatus)

export const pingPanelBridge = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(async () => (await ping()) as any)

export const sendPanelBridgeSetupCommand = createServerFn({ method: 'POST' })
  .middleware(setupMiddleware())
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeSetupAction(data)) as any)

;(getPanelBridgeStatus as any).__executeImplementation = getStatus
;(pingPanelBridge as any).__executeImplementation = ping
;(sendPanelBridgeSetupCommand as any).__executeImplementation = (
  data: unknown,
) => executeSetupAction(record(data))
