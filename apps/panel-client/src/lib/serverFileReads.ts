import { createServerFn } from '@tanstack/react-start'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

type AnyRecord = Record<string, any>

type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  status?: unknown
}

type FileType = 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const details = error as ServiceError
    if (typeof details.error === 'string') return details.error
    if (typeof details.message === 'string') return details.message
  }
  return String(error)
}

function throwFileError(
  error: unknown,
  fallbackStatus = 500,
  fallbackCode?: string,
): never {
  const details =
    error && typeof error === 'object' ? (error as ServiceError) : {}
  throw Object.assign(new Error(errorMessage(error)), {
    status:
      typeof details.status === 'number' ? details.status : fallbackStatus,
    ...(typeof details.code === 'string'
      ? { code: details.code }
      : fallbackCode
        ? { code: fallbackCode }
        : {}),
  })
}

function createFileRead<T>(handler: (data: AnyRecord) => Promise<T> | T) {
  const implementation = async (data: AnyRecord): Promise<T> => {
    try {
      return await handler(data)
    } catch (error) {
      throwFileError(error)
    }
  }

  return Object.assign(
    createServerFn({ method: 'GET' })
      .middleware([
        ...protectedServerFunctionMiddleware,
        permissionMiddleware('serverfiles.manage'),
      ] as const)
      .validator((data: unknown) =>
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as AnyRecord)
          : {},
      )
      .handler(({ data }) => implementation(data) as any),
    { __executeImplementation: implementation },
  )
}

function unescapeLuaString(value: unknown): string {
  const source = String(value)
  const unescapes: Record<string, string> = {
    '\\': '\\',
    '"': '"',
    "'": "'",
    n: '\n',
    r: '\r',
    t: '\t',
    0: '\0',
    '[': '[',
    ']': ']',
  }
  if (!/^"[\s\S]*"$|^'[\s\S]*'$/.test(source)) {
    return source.replace(/^["']|["']$/g, '')
  }
  return source
    .slice(1, -1)
    .replace(/\\([\s\S])/g, (match, character) =>
      Object.prototype.hasOwnProperty.call(unescapes, character)
        ? unescapes[character]
        : match,
    )
}

function parseIni(content: string): AnyRecord {
  const result: AnyRecord = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const equals = trimmed.indexOf('=')
    if (equals > 0) {
      result[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim()
    }
  }
  return result
}

function maskSensitiveIniLines(content: string, sanitize: AnyRecord): string {
  const sensitive = sanitize.SENSITIVE_FIELD_RE as RegExp
  const maskSecretValue = sanitize.maskSecretValue as (
    value: unknown,
  ) => unknown
  return content
    .split(/\r?\n/)
    .map((line) => {
      const equals = line.indexOf('=')
      if (equals <= 0) return line
      const key = line.slice(0, equals).trim()
      const value = line.slice(equals + 1)
      if (!sensitive.test(key) || !value) return line
      return `${line.slice(0, equals + 1)}${String(maskSecretValue(value))}`
    })
    .join('\n')
}

function parseSandboxVars(content: string): AnyRecord {
  const result: AnyRecord = {
    VERSION: 4,
    settings: {},
    ZombieLore: {},
    ZombieConfig: {},
    MultiplierConfig: {},
    Map: {},
    Basement: {},
    Music: {},
    Debug: {},
  }
  const nestedBlocks = [
    'ZombieLore',
    'ZombieConfig',
    'MultiplierConfig',
    'Map',
    'Basement',
    'Music',
    'Debug',
  ]
  const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  try {
    const version = content.match(/VERSION\s*=\s*(\d+)/)
    if (version) result.VERSION = Number.parseInt(version[1], 10)

    let topLevelContent = content
    for (const block of nestedBlocks) {
      topLevelContent = topLevelContent.replace(
        new RegExp(
          `${escapeRegExp(block)}\\s*=\\s*\\{[\\s\\S]*?\\n\\s*\\}`,
          'm',
        ),
        '',
      )
    }

    const simplePattern =
      /^\s*(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,{}\n]+),?\s*(?:--.*)?$/gm
    let match: RegExpExecArray | null
    while ((match = simplePattern.exec(topLevelContent))) {
      const key = match[1]
      if (nestedBlocks.includes(key) || key === 'VERSION') continue
      let value: any = match[2].trim()
      if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (!Number.isNaN(Number.parseFloat(value)))
        value = Number.parseFloat(value)
      else value = unescapeLuaString(value)
      result.settings[key] = value
    }

    for (const block of nestedBlocks) {
      const blockMatch = content.match(
        new RegExp(
          `${escapeRegExp(block)}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
          'm',
        ),
      )
      if (!blockMatch) continue
      const blockContent = blockMatch[1].replace(/^\s*--.*$/gm, '')
      const values = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\n]+)/g
      let valueMatch: RegExpExecArray | null
      while ((valueMatch = values.exec(blockContent))) {
        let value: any = valueMatch[2].trim().replace(/,\s*$/, '')
        if (value === 'true') value = true
        else if (value === 'false') value = false
        else if (!Number.isNaN(Number.parseFloat(value)))
          value = Number.parseFloat(value)
        else value = unescapeLuaString(value)
        result[block][valueMatch[1]] = value
      }
    }
  } catch {
    // Keep the same forgiving read contract as the legacy endpoint.
  }
  return result
}

function parseSpawnPoints(content: string): AnyRecord {
  const professions: AnyRecord = {}
  const professionPattern = /(\w+)\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g
  let profession: RegExpExecArray | null
  while ((profession = professionPattern.exec(content))) {
    if (profession[1] === 'return') continue
    const points: AnyRecord[] = []
    const pointPattern =
      /\{\s*worldX\s*=\s*(\d+)\s*,\s*worldY\s*=\s*(\d+)\s*,\s*posX\s*=\s*([\d.]+)\s*,\s*posY\s*=\s*([\d.]+)(?:\s*,\s*posZ\s*=\s*(\d+))?\s*\}/g
    let point: RegExpExecArray | null
    while ((point = pointPattern.exec(profession[2]))) {
      points.push({
        worldX: Number.parseInt(point[1], 10),
        worldY: Number.parseInt(point[2], 10),
        posX: Number.parseFloat(point[3]),
        posY: Number.parseFloat(point[4]),
        posZ: point[5] ? Number.parseInt(point[5], 10) : 0,
      })
    }
    if (points.length) professions[profession[1]] = points
  }
  return professions
}

function parseSpawnRegions(content: string): AnyRecord[] {
  const regions: AnyRecord[] = []
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().startsWith('--')) continue
    const name = line.match(/name\s*=\s*"([^"]+)"/)
    const file = line.match(/(?:server)?file\s*=\s*"([^"]+)"/)
    if (name && file) {
      regions.push({
        name: name[1],
        file: file[1],
        isServerFile: line.includes('serverfile'),
      })
    }
  }
  return regions
}

async function withServerFiles<T>(
  reader: (
    configPath: string,
    serverName: string,
    activeServer: AnyRecord | null,
  ) => Promise<T>,
): Promise<T> {
  const {
    getActiveServerContext,
    RemoteConfigNotConfiguredError,
    ServerNotConfiguredError,
    resolveRemoteConfigTransport,
  } = await import('../../../panel-server/services/sandboxPersistence.ts')
  const context = await getActiveServerContext()
  if (context.configurationError) {
    throwFileError(
      context.configurationError,
      context.configurationError.code === 'REMOTE_CONFIG_NOT_CONFIGURED'
        ? 400
        : 404,
      context.configurationError.code,
    )
  }
  if (!context.serverConfigPath)
    throwFileError(new ServerNotConfiguredError(), 404)
  let serverName = context.serverName
  if (!serverName) {
    const { getServerName } =
      await import('../../../panel-server/services/sandboxPersistence.ts')
    serverName = await getServerName(context.activeServer)
  }

  if (!context.activeServer?.isRemote) {
    return reader(context.serverConfigPath, serverName, context.activeServer)
  }

  const transport = await resolveRemoteConfigTransport()
  if (!transport) throwFileError(new RemoteConfigNotConfiguredError(), 400)
  const { acquireMirrorLock, beginRemoteConfigSession } =
    await import('../../../panel-server/services/remoteConfigFiles.ts')
  const release = await acquireMirrorLock()
  try {
    let session
    try {
      session = await beginRemoteConfigSession(transport, serverName, {
        fresh: false,
      })
    } catch (error) {
      throwFileError(error, 502)
    }
    return reader(session.mirrorDir, serverName, context.activeServer)
  } finally {
    release()
  }
}

async function readConfigFile(
  configPath: string,
  filename: string,
  code: string,
): Promise<string> {
  try {
    return await (
      await import('node:fs/promises')
    ).readFile((await import('node:path')).join(configPath, filename), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      const messages: Record<string, string> = {
        INI_FILE_NOT_FOUND: 'INI file not found',
        SANDBOXVARS_FILE_NOT_FOUND: 'SandboxVars file not found',
        SPAWNPOINTS_FILE_NOT_FOUND: 'Spawn points file not found',
        SPAWNREGIONS_FILE_NOT_FOUND: 'Spawn regions file not found',
      }
      throwFileError(new Error(messages[code] || 'File not found'), 404, code)
    }
    throw error
  }
}

const fileName = (serverName: string, type: FileType): string =>
  ({
    ini: `${serverName}.ini`,
    sandbox: `${serverName}_SandboxVars.lua`,
    spawnpoints: `${serverName}_spawnpoints.lua`,
    spawnregions: `${serverName}_spawnregions.lua`,
  })[type]

export const getServerFilePaths = createFileRead(async () =>
  withServerFiles(async (configPath, serverName) => {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const files = {
      ini: join(configPath, fileName(serverName, 'ini')),
      sandbox: join(configPath, fileName(serverName, 'sandbox')),
      spawnpoints: join(configPath, fileName(serverName, 'spawnpoints')),
      spawnregions: join(configPath, fileName(serverName, 'spawnregions')),
    }
    return {
      configPath,
      serverName,
      files,
      exists: Object.fromEntries(
        Object.entries(files).map(([key, value]) => [key, existsSync(value)]),
      ),
    }
  }),
)

export const getServerIni = createFileRead(async () =>
  withServerFiles(async (configPath, serverName) => {
    const { maskSensitiveObject } =
      await import('../../../panel-server/utils/sanitize.ts')
    const { findDuplicateIniKeys } =
      await import('../../../panel-server/utils/iniDuplicateKeys.ts')
    const { join } = await import('node:path')
    const content = await readConfigFile(
      configPath,
      fileName(serverName, 'ini'),
      'INI_FILE_NOT_FOUND',
    )
    return {
      settings: maskSensitiveObject(parseIni(content)),
      path: join(configPath, fileName(serverName, 'ini')),
      serverName,
      duplicateKeys: findDuplicateIniKeys(content),
    }
  }),
)

export const getServerSandbox = createFileRead(async () =>
  withServerFiles(async (configPath, serverName) => ({
    sandbox: parseSandboxVars(
      await readConfigFile(
        configPath,
        fileName(serverName, 'sandbox'),
        'SANDBOXVARS_FILE_NOT_FOUND',
      ),
    ),
    path: (await import('node:path')).join(
      configPath,
      fileName(serverName, 'sandbox'),
    ),
    serverName,
  })),
)

export const validateServerSandbox = createFileRead(async () =>
  withServerFiles(async (configPath, serverName) => {
    const content = await readConfigFile(
      configPath,
      fileName(serverName, 'sandbox'),
      'SANDBOXVARS_FILE_NOT_FOUND',
    )
    let depth = 0
    let wentNegative = false
    for (const character of content) {
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth < 0) wentNegative = true
      }
    }
    return { valid: depth === 0 && !wentNegative, braceDepth: depth }
  }),
)

export const getServerSpawnPoints = createFileRead(async () =>
  withServerFiles(async (configPath, serverName) => ({
    spawnpoints: parseSpawnPoints(
      await readConfigFile(
        configPath,
        fileName(serverName, 'spawnpoints'),
        'SPAWNPOINTS_FILE_NOT_FOUND',
      ),
    ),
    path: (await import('node:path')).join(
      configPath,
      fileName(serverName, 'spawnpoints'),
    ),
  })),
)

export const getServerSpawnRegions = createFileRead(async () =>
  withServerFiles(async (configPath, serverName) => ({
    spawnregions: parseSpawnRegions(
      await readConfigFile(
        configPath,
        fileName(serverName, 'spawnregions'),
        'SPAWNREGIONS_FILE_NOT_FOUND',
      ),
    ),
    path: (await import('node:path')).join(
      configPath,
      fileName(serverName, 'spawnregions'),
    ),
  })),
)

export const getServerRawFile = createFileRead(async (data) =>
  withServerFiles(async (configPath, serverName) => {
    const type = data.type
    if (
      !['ini', 'sandbox', 'spawnpoints', 'spawnregions'].includes(String(type))
    ) {
      throwFileError(
        new Error('Invalid file type'),
        400,
        'RAW_FILE_INVALID_TYPE',
      )
    }
    const fileType = type as FileType
    const content = await readConfigFile(
      configPath,
      fileName(serverName, fileType),
      'FILE_NOT_FOUND',
    )
    if (fileType === 'ini') {
      const sanitize = await import('../../../panel-server/utils/sanitize.ts')
      return {
        content: maskSensitiveIniLines(content, sanitize),
        filename: fileName(serverName, fileType),
      }
    }
    return {
      content,
      filename: fileName(serverName, fileType),
    }
  }),
)

export const getServerConfigBackups = createFileRead(async () =>
  withServerFiles(async (configPath) => {
    const { getBackupPath } =
      await import('../../../panel-server/utils/configBackup.ts')
    const { readdir, stat } = await import('node:fs/promises')
    const backupPath = await getBackupPath(configPath)
    try {
      const entries = await readdir(backupPath)
      const files = (
        await Promise.all(
          entries
            .filter((filename) => filename.endsWith('.bak'))
            .map(async (filename) => {
              try {
                const details = await stat(
                  (await import('node:path')).join(backupPath, filename),
                )
                return {
                  filename,
                  size: details.size,
                  created: details.birthtime,
                }
              } catch {
                return null
              }
            }),
        )
      )
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((a, b) => b.created.getTime() - a.created.getTime())
      return { backups: files, path: backupPath }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return { backups: [] }
      throw error
    }
  }),
)

async function getTemplatesPath(configPath: string): Promise<string> {
  return (await import('node:path')).join(configPath, 'templates')
}

export const getConfigTemplates = createFileRead(async () =>
  withServerFiles(async (configPath) => {
    const { mkdir, open, readdir } = await import('node:fs/promises')
    const templatesPath = await getTemplatesPath(configPath)
    await mkdir(templatesPath, { recursive: true })
    const files = (
      await Promise.all(
        (await readdir(templatesPath))
          .filter((filename) => filename.endsWith('.json'))
          .map(async (filename) => {
            try {
              const filePath = (await import('node:path')).join(
                templatesPath,
                filename,
              )
              const handle = await open(filePath, 'r')
              try {
                const [details, content] = await Promise.all([
                  handle.stat(),
                  handle.readFile({ encoding: 'utf8' }),
                ])
                const template = JSON.parse(content)
                return {
                  id: filename.slice(0, -5),
                  name: template.name || filename.slice(0, -5),
                  description: template.description || '',
                  type: template.type || 'both',
                  created: template.created || details.birthtime.toISOString(),
                  modified: details.mtime.toISOString(),
                  hasIni: Boolean(template.ini),
                  hasSandbox: Boolean(template.sandbox),
                }
              } finally {
                await handle.close()
              }
            } catch {
              return null
            }
          }),
      )
    )
      .filter(
        (template): template is NonNullable<typeof template> =>
          template !== null,
      )
      .sort(
        (a, b) =>
          new Date(b.modified).getTime() - new Date(a.modified).getTime(),
      )
    return { templates: files }
  }),
)

function safeTemplateId(value: unknown): string {
  const id = String(value ?? '')
  const safe = id.replace(/[^a-z0-9_-]/gi, '')
  if (!safe || safe !== id) {
    throwFileError(new Error('Invalid template ID'), 400, 'TEMPLATE_ID_INVALID')
  }
  return safe
}

export const getConfigTemplate = createFileRead(async (data) =>
  withServerFiles(async (configPath) => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const id = safeTemplateId(data.id)
    const templatePath = join(await getTemplatesPath(configPath), `${id}.json`)
    try {
      return JSON.parse(await readFile(templatePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throwFileError(
          new Error('Template not found'),
          404,
          'TEMPLATE_NOT_FOUND',
        )
      }
      throw error
    }
  }),
)

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
])

async function getAllowedBrowseRoots(
  activeServer: AnyRecord | null,
): Promise<string[]> {
  const { getAllSettings } =
    await import('../../../panel-server/database/init.ts')
  const { homedir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const settings = await getAllSettings()
  return [
    activeServer?.serverConfigPath,
    activeServer?.zomboidDataPath,
    activeServer?.serverPath,
    settings.serverConfigPath,
    settings.zomboidDataPath,
    join(homedir(), 'Zomboid'),
  ]
    .filter(
      (root): root is string => typeof root === 'string' && root.length > 0,
    )
    .map((root) => resolve(root))
    .filter((root, index, roots) => roots.indexOf(root) === index)
}

export const browseServerFiles = createFileRead(async (data) =>
  withServerFiles(async (configPath, _serverName, activeServer) => {
    if (activeServer?.isRemote) {
      throwFileError(
        new Error(
          'Browsing the server filesystem is not available for remote servers.',
        ),
        400,
        'REMOTE_BROWSE_NOT_AVAILABLE',
      )
    }
    const { confineToRoots } =
      await import('../../../panel-server/utils/browseRoots.ts')
    const { existsSync } = await import('node:fs')
    const { readdir, stat } = await import('node:fs/promises')
    const { dirname, extname } = await import('node:path')
    const roots = await getAllowedBrowseRoots(activeServer)
    const requestedPath =
      typeof data.path === 'string' && data.path ? data.path : null
    const targetPath = requestedPath
      ? confineToRoots(requestedPath, roots)
      : configPath
    if (requestedPath && !targetPath) {
      throwFileError(
        new Error('Access denied: path is outside allowed server directories'),
        403,
        'BROWSE_ACCESS_DENIED',
      )
    }
    if (!targetPath)
      throwFileError(new Error('No path provided'), 400, 'BROWSE_NO_PATH')
    if (!existsSync(targetPath))
      throwFileError(
        new Error('Path does not exist'),
        400,
        'BROWSE_PATH_NOT_FOUND',
      )
    if (!(await stat(targetPath)).isDirectory()) {
      throwFileError(
        new Error('Path is not a directory'),
        400,
        'BROWSE_PATH_NOT_DIRECTORY',
      )
    }

    const extensions =
      typeof data.extensions === 'string'
        ? data.extensions
            .split(',')
            .map((extension) => extension.toLowerCase().trim())
        : null
    const directories: string[] = []
    const files: Array<{ name: string; ext: string }> = []
    for (const entry of await readdir(targetPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules')
          directories.push(entry.name)
        continue
      }
      const extension = extname(entry.name).toLowerCase()
      if (
        extensions
          ? extensions.includes(extension)
          : IMAGE_EXTENSIONS.has(extension)
      ) {
        files.push({ name: entry.name, ext: extension })
      }
    }
    directories.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    )
    files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
    const parentPath = dirname(targetPath)
    return {
      currentPath: targetPath,
      parent:
        parentPath !== targetPath && confineToRoots(parentPath, roots)
          ? parentPath
          : null,
      directories,
      files,
    }
  }),
)
