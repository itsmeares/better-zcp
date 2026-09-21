import { createServerFn } from '@tanstack/react-start'
import { protectedServerFunctionMiddleware } from './serverAuth.server'

type AnyRecord = Record<string, any>

type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  status?: unknown
  params?: unknown
  success?: unknown
  detail?: unknown
  reason?: unknown
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
    ...(details.params !== undefined ? { params: details.params } : {}),
    ...(details.success === false ? { success: false } : {}),
    ...(typeof details.detail === 'string' ? { detail: details.detail } : {}),
    ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
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
      .middleware(protectedServerFunctionMiddleware)
      .validator((data: unknown) =>
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as AnyRecord)
          : {},
      )
      .handler(({ data }) => implementation(data) as any),
    { __executeImplementation: implementation },
  )
}

function createFileMutation<T>(handler: (data: AnyRecord) => Promise<T> | T) {
  const implementation = async (data: AnyRecord): Promise<T> => {
    try {
      return await handler(data)
    } catch (error) {
      throwFileError(error)
    }
  }

  return Object.assign(
    createServerFn({ method: 'POST' })
      .middleware(protectedServerFunctionMiddleware)
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

type ResolvedServerFiles = {
  configPath: string
  serverName: string
  activeServer: AnyRecord | null
}

async function resolveServerFiles(): Promise<ResolvedServerFiles> {
  const { getActiveServerContext, ServerNotConfiguredError } =
    await import('../../../panel-server/services/sandboxPersistence.ts')
  const context = await getActiveServerContext()
  if (context.configurationError) {
    throwFileError(
      context.configurationError,
      404,
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
  return {
    configPath: context.serverConfigPath,
    serverName,
    activeServer: context.activeServer,
  }
}

export async function withServerFiles<T>(
  reader: (
    configPath: string,
    serverName: string,
    activeServer: AnyRecord | null,
  ) => Promise<T>,
): Promise<T> {
  const { configPath, serverName, activeServer } = await resolveServerFiles()

  return reader(configPath, serverName, activeServer)
}

export async function withWritableServerFiles<T>(
  writer: (
    configPath: string,
    serverName: string,
    activeServer: AnyRecord | null,
  ) => Promise<T>,
): Promise<T> {
  const { configPath, serverName, activeServer } = await resolveServerFiles()
  return writer(configPath, serverName, activeServer)
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

const SERVER_STATE_UNKNOWN_MESSAGE =
  "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection."

function hasUnsafeObjectKey(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return ['__proto__', 'constructor', 'prototype'].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  )
}

function fileFailure(
  message: string,
  status: number,
  code: string,
  details: AnyRecord = {},
): never {
  throwFileError(Object.assign(new Error(message), details), status, code)
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

async function localPathsExist(
  activeServer: AnyRecord | null,
): Promise<boolean> {
  const { existsSync } = await import('node:fs')
  const configuredPath =
    activeServer?.installPath || process.env.PZ_SERVER_PATH || ''
  const configuredDataPath =
    activeServer?.zomboidDataPath || process.env.PZ_SAVE_PATH || ''
  const pathsConfigured = Boolean(configuredPath || configuredDataPath)
  if (!pathsConfigured) return true
  return Boolean(
    (configuredPath && existsSync(configuredPath)) ||
      (configuredDataPath && existsSync(configuredDataPath)),
  )
}

async function configEditRestartRequired(
  activeServer: AnyRecord | null,
): Promise<boolean> {
  if (!(await localPathsExist(activeServer))) return true
  const runtime = await panelRuntime()
  const serverManager = runtime.serverManager as AnyRecord | undefined
  if (
    typeof serverManager?.reloadConfig !== 'function' ||
    typeof serverManager?.getServerProcessDetails !== 'function'
  ) {
    return true
  }
  try {
    await serverManager.reloadConfig()
    const details = await serverManager.getServerProcessDetails()
    return Boolean(details?.scanFailed || details?.running !== false)
  } catch {
    return true
  }
}

async function requireConfigServerStopped(
  activeServer: AnyRecord | null,
): Promise<void> {
  if (!(await localPathsExist(activeServer))) {
    fileFailure(SERVER_STATE_UNKNOWN_MESSAGE, 503, 'SERVER_STATE_UNKNOWN')
  }

  const runtime = await panelRuntime()
  const serverManager = runtime.serverManager as AnyRecord | undefined
  if (
    typeof serverManager?.reloadConfig !== 'function' ||
    typeof serverManager?.getServerProcessDetails !== 'function'
  ) {
    fileFailure(SERVER_STATE_UNKNOWN_MESSAGE, 503, 'SERVER_STATE_UNKNOWN')
  }

  try {
    await serverManager.reloadConfig()
    const details = await serverManager.getServerProcessDetails()
    if (details?.scanFailed) {
      fileFailure(SERVER_STATE_UNKNOWN_MESSAGE, 503, 'SERVER_STATE_UNKNOWN')
    }
    if (details?.running) {
      fileFailure(
        'Stop the server before editing configuration.',
        409,
        'SERVER_RUNNING',
      )
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as { status?: unknown }).status === 'number'
    ) {
      throw error
    }
    fileFailure(SERVER_STATE_UNKNOWN_MESSAGE, 503, 'SERVER_STATE_UNKNOWN')
  }
}

function toIni(obj: AnyRecord, originalContent = ''): string {
  if (originalContent) {
    const lineEnding = originalContent.includes('\r\n') ? '\r\n' : '\n'
    const lines = originalContent.split(/\r?\n/)
    const result: string[] = []
    const written = new Set<string>()

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
        result.push(line)
        continue
      }
      const equals = trimmed.indexOf('=')
      if (equals <= 0) {
        result.push(line)
        continue
      }
      const key = trimmed.slice(0, equals).trim()
      if (!(key in obj)) {
        result.push(line)
        continue
      }
      const safeValue = String(obj[key]).replace(/[\r\n]/g, '')
      const lineEquals = line.indexOf('=')
      const valueMatch = line
        .slice(lineEquals + 1)
        .match(/^(\s*)([\s\S]*?)(\s*)$/)
      if (!valueMatch) {
        result.push(line)
        continue
      }
      result.push(
        `${line.slice(0, lineEquals + 1)}${valueMatch[1]}${safeValue}${valueMatch[3]}`,
      )
      written.add(key)
    }

    for (const [key, value] of Object.entries(obj)) {
      if (
        written.has(key) ||
        value === '' ||
        value === null ||
        value === undefined
      )
        continue
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue
      result.push(`${key}=${String(value).replace(/[\r\n]/g, '')}`)
    }
    return result.join(lineEnding)
  }

  return Object.entries(obj)
    .filter(
      ([key, value]) =>
        value !== '' &&
        value !== null &&
        value !== undefined &&
        /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key),
    )
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, '')}`)
    .join('\n')
}

type MaskedIniResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'unresolvable' | 'removed'; key: string }

type MaskedIniFailure = Extract<MaskedIniResult, { ok: false }>

function reconcileMaskedIniLines(
  incomingContent: string,
  liveContent: string,
  sanitize: AnyRecord,
): MaskedIniResult {
  const sensitive = sanitize.SENSITIVE_FIELD_RE as RegExp
  const masked = sanitize.isMaskedSecret as (value: unknown) => boolean
  const indexByKey = (text: string) => {
    const byKey = new Map<
      string,
      Array<{ index: number; line: string; value: string }>
    >()
    text.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return
      const equals = trimmed.indexOf('=')
      if (equals <= 0) return
      const key = trimmed.slice(0, equals).trim()
      const value = trimmed.slice(equals + 1)
      const entries = byKey.get(key) ?? []
      entries.push({ index, line, value })
      byKey.set(key, entries)
    })
    return byKey
  }

  const incomingByKey = indexByKey(incomingContent)
  const liveByKey = indexByKey(liveContent)
  const lines = incomingContent.split(/\r?\n/)
  for (const [key, entries] of incomingByKey) {
    if (!sensitive.test(key)) continue
    const maskedEntries = entries.filter((entry) => masked(entry.value))
    if (!maskedEntries.length) continue
    const liveEntries = liveByKey.get(key) ?? []
    if (maskedEntries.length !== 1 || liveEntries.length !== 1) {
      return { ok: false, reason: 'unresolvable', key }
    }
    lines[maskedEntries[0].index] = liveEntries[0].line
  }
  for (const [key, entries] of liveByKey) {
    if (!sensitive.test(key) || entries.length !== 1 || !entries[0].value)
      continue
    if (!incomingByKey.has(key)) return { ok: false, reason: 'removed', key }
  }
  return { ok: true, content: lines.join('\n') }
}

function createSandboxVars(sandbox: AnyRecord): string {
  const sections = [
    'settings',
    'ZombieLore',
    'ZombieConfig',
    'MultiplierConfig',
    'Map',
    'Basement',
  ]
  const formatValue = (value: unknown): string => {
    if (typeof value === 'boolean') return String(value)
    if (typeof value === 'number' && Number.isFinite(value))
      return String(value)
    return `"${String(value).replace(
      /[\\"'\n\r\t\0\[\]]/g,
      (character) =>
        ({
      '\\': '\\\\',
      '"': '\\"',
      "'": "\\'",
      '\n': '\\n',
      '\r': '\\r',
      '\t': '\\t',
      '\0': '\\0',
      '[': '\\[',
      ']': '\\]',
        })[character] ?? character,
    )}"`
  }
  const lines = ['SandboxVars = {']
  lines.push(
    `    VERSION = ${Number.isInteger(sandbox.VERSION) ? sandbox.VERSION : 4},`,
  )
  for (const section of sections) {
    const values = sandbox[section]
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue
    if (section === 'settings') {
      for (const [key, value] of Object.entries(values)) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
          lines.push(`    ${key} = ${formatValue(value)},`)
      }
      continue
    }
    lines.push(`    ${section} = {`)
    for (const [key, value] of Object.entries(values)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
        lines.push(`        ${key} = ${formatValue(value)},`)
    }
    lines.push('    },')
  }
  lines.push('}')
  return `${lines.join('\n')}\n`
}

const SANDBOX_WRITABLE_SECTIONS = [
  'settings',
  'ZombieLore',
  'ZombieConfig',
  'MultiplierConfig',
  'Map',
  'Basement',
]

function findUnpersistedSandboxKeys(
  submitted: AnyRecord,
  persisted: AnyRecord,
): string[] {
  const missing: string[] = []
  for (const section of SANDBOX_WRITABLE_SECTIONS) {
    const submittedSection = submitted[section]
    if (!submittedSection || typeof submittedSection !== 'object') continue
    const persistedSection =
      section === 'settings' ? persisted.settings : persisted[section]
    for (const [key, value] of Object.entries(submittedSection)) {
      if ((persistedSection || {})[key] !== value) {
        missing.push(section === 'settings' ? key : `${section}.${key}`)
      }
    }
  }
  return missing
}

function checkSandboxBalance(content: string): {
  balanced: boolean
  depth: number
} {
  let depth = 0
  let wentNegative = false
  for (const character of content) {
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth < 0) wentNegative = true
    }
  }
  return { balanced: depth === 0 && !wentNegative, depth }
}

function repairSandboxSyntax(content: string): {
  content: string
  fixed: boolean
  changes: string[]
} {
  const before = checkSandboxBalance(content)
  if (before.balanced) return { content, fixed: false, changes: [] }

  const lines = content.split(/\r?\n/)
  const changes: string[] = []
  const scalarLine =
    /^(\s*)(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)\s*(--.*)?$/
  const entryLine = /^(\s*)(\w+)\s*=\s*/
  let syntheticCounter = 0
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(scalarLine)
    if (!match) continue
    let next = index + 1
    while (
      next < lines.length &&
      (!lines[next].trim() || /^\s*--/.test(lines[next]))
    )
      next += 1
    if (next >= lines.length) continue
    const nextEntry = lines[next].match(entryLine)
    if (!nextEntry || nextEntry[1].length <= match[1].length) continue
    syntheticCounter += 1
    changes.push(
      `Line ${index + 1}: '${match[2]} = ${match[3]}' looked like an orphaned block entry (missing block header and comma) — wrapped it in a synthetic '_RepairedBlock${syntheticCounter}' table so the file parses again.`,
    )
    lines[index] =
      `${match[1]}_RepairedBlock${syntheticCounter} = {\n${match[1]}    ${match[2]} = ${match[3]},`
  }
  const repaired = lines.join('\n')
  const after = checkSandboxBalance(repaired)
  return {
    content: repaired,
    fixed: after.balanced && changes.length > 0,
    changes,
  }
}

function toSpawnPoints(professions: AnyRecord): string {
  const lines = ['function SpawnPoints()', '\treturn {']
  for (const [profession, points] of Object.entries(professions)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(profession) || !Array.isArray(points))
      continue
    lines.push(`\t\t${profession} = {`)
    for (const point of points as AnyRecord[]) {
      const x = Number.isFinite(Number(point.worldX)) ? Number(point.worldX) : 0
      const y = Number.isFinite(Number(point.worldY)) ? Number(point.worldY) : 0
      const posX = Number.isFinite(Number(point.posX)) ? Number(point.posX) : 0
      const posY = Number.isFinite(Number(point.posY)) ? Number(point.posY) : 0
      const z = Number.isFinite(Number(point.posZ)) ? Number(point.posZ) : 0
      lines.push(
        z
          ? `\t\t\t{ worldX = ${x}, worldY = ${y}, posX = ${posX}, posY = ${posY}, posZ = ${z} }`
          : `\t\t\t{ worldX = ${x}, worldY = ${y}, posX = ${posX}, posY = ${posY} }`,
      )
    }
    lines.push('\t\t}')
  }
  lines.push('\t}', 'end')
  return lines.join('\n')
}

function toSpawnRegions(regions: AnyRecord[]): string {
  const escape = (value: unknown): string =>
    String(value).replace(
      /[\\"'\n\r\t\0\[\]]/g,
      (character) =>
        ({
      '\\': '\\\\',
      '"': '\\"',
      "'": "\\'",
      '\n': '\\n',
      '\r': '\\r',
      '\t': '\\t',
      '\0': '\\0',
      '[': '\\[',
      ']': '\\]',
        })[character] ?? character,
    )
  const lines = ['function SpawnRegions()', '        return {']
  for (const region of regions) {
    if (!region || typeof region !== 'object') continue
    const key = region.isServerFile ? 'serverfile' : 'file'
    lines.push(
      `                { name = "${escape(region.name)}", ${key} = "${escape(region.file)}" },`,
    )
  }
  lines.push('        }', 'end')
  return lines.join('\n')
}

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

export const saveServerIni = createFileMutation(async (data) =>
  withWritableServerFiles(async (configPath, serverName, activeServer) => {
    const settings = data.settings
    if (!settings || typeof settings !== 'object') {
      fileFailure('Settings object required', 400, 'INI_SETTINGS_REQUIRED')
    }
    if (hasUnsafeObjectKey(settings)) {
      fileFailure('Invalid settings', 400, 'INI_SETTINGS_INVALID')
    }

    const { existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { findDuplicateIniKeys } =
      await import('../../../panel-server/utils/iniDuplicateKeys.ts')
    const { SENSITIVE_FIELD_RE, isMaskedSecret, maskSensitiveObject } =
      await import('../../../panel-server/utils/sanitize.ts')
    const { withFileLock, writeFileAtomic } =
      await import('../../../panel-server/utils/fileWriteQueue.ts')

    const filePath = join(configPath, fileName(serverName, 'ini'))
    const currentContent = existsSync(filePath)
      ? readFileSync(filePath, 'utf8')
      : ''
    const duplicateKeys = findDuplicateIniKeys(currentContent)
    if (duplicateKeys.length > 0) {
      fileFailure(
        "This file has a key duplicated across two config blocks. Saving from the structured editor would permanently discard one copy's value. Use the raw editor tab to fix the duplicate first.",
        409,
        'INI_DUPLICATE_KEY_BLOCKS_STRUCTURED_SAVE',
        { duplicateKeys },
      )
    }

    const submitted: AnyRecord = {}
    for (const [key, value] of Object.entries(settings as AnyRecord)) {
      if (SENSITIVE_FIELD_RE.test(key) && isMaskedSecret(value)) continue
      submitted[key] = value
    }

    const restartRequired = await configEditRestartRequired(activeServer)
    let backupWarning: string | null = null
    const persisted = await withFileLock(filePath, async () => {
      let original = ''
      if (existsSync(filePath)) {
        original = readFileSync(filePath, 'utf8')
        const { backupWarningFor, createBackup } =
          await import('../../../panel-server/utils/configBackup.ts')
        backupWarning = backupWarningFor(
          await createBackup(configPath, fileName(serverName, 'ini')),
        )
      }
      writeFileAtomic(filePath, toIni(submitted, original), 'utf8')
      const saved = parseIni(readFileSync(filePath, 'utf8'))
      const originalValues = parseIni(original)
      for (const [key, value] of Object.entries(submitted)) {
        const existed = Object.prototype.hasOwnProperty.call(
          originalValues,
          key,
        )
        const nonEmpty = value !== '' && value !== null && value !== undefined
        if (
          (existed || nonEmpty) &&
          saved[key] !== String(value).replace(/[\r\n]/g, '')
        ) {
          throw new Error(`INI write verification failed for ${key}`)
        }
      }
      return saved
    })

    return {
      success: true,
      message: 'Settings saved',
      path: filePath,
      settings: maskSensitiveObject(persisted),
      ...(backupWarning ? { backupWarning } : {}),
      ...(restartRequired ? { restartRequired: true } : {}),
    }
  }),
)

export const saveServerSandbox = createFileMutation(async (data) =>
  withWritableServerFiles(async (configPath, serverName, activeServer) => {
    const sandbox = data.sandbox
    if (!sandbox || typeof sandbox !== 'object') {
      fileFailure('Sandbox object required', 400, 'SANDBOX_OBJECT_REQUIRED')
    }
    if (
      hasUnsafeObjectKey(sandbox) ||
      Object.values(sandbox as AnyRecord).some(hasUnsafeObjectKey)
    ) {
      fileFailure('Invalid sandbox data', 400, 'SANDBOX_DATA_INVALID')
    }
    if (JSON.stringify(sandbox).length > 1024 * 1024) {
      fileFailure(
        'Sandbox data too large (max 1MB)',
        400,
        'SANDBOX_DATA_TOO_LARGE',
      )
    }

    const { existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { withFileLock, writeFileAtomic } =
      await import('../../../panel-server/utils/fileWriteQueue.ts')
    const { createBackup, backupWarningFor } =
      await import('../../../panel-server/utils/configBackup.ts')
    const { modifySandboxValue } =
      await import('../../../panel-server/services/sandboxPersistence.ts')
    const filePath = join(configPath, fileName(serverName, 'sandbox'))
    const restartRequired = await configEditRestartRequired(activeServer)
    let created = false
    let backupWarning: string | null = null
    let unpersistedKeys: string[] = []
    await withFileLock(filePath, async () => {
      created = !existsSync(filePath)
      const original = created ? '' : readFileSync(filePath, 'utf8')
      let content = original
      if (created) {
        content = createSandboxVars(sandbox as AnyRecord)
      } else {
        for (const [section, values] of Object.entries(sandbox as AnyRecord)) {
          if (!SANDBOX_WRITABLE_SECTIONS.includes(section)) continue
          if (!values || typeof values !== 'object' || Array.isArray(values))
            continue
          for (const [key, value] of Object.entries(values)) {
            content = modifySandboxValue(
              content,
              key,
              value,
              section === 'settings' ? null : section,
            )
          }
        }
        backupWarning = backupWarningFor(
          await createBackup(configPath, fileName(serverName, 'sandbox')),
        )
      }
      writeFileAtomic(filePath, content, 'utf8')
      unpersistedKeys = findUnpersistedSandboxKeys(
        sandbox as AnyRecord,
        parseSandboxVars(readFileSync(filePath, 'utf8')),
      )
    })

    return {
      success: true,
      created,
      message: created ? 'SandboxVars file created' : 'Sandbox settings saved',
      path: filePath,
      ...(unpersistedKeys.length > 0 ? { unpersistedKeys } : {}),
      ...(backupWarning ? { backupWarning } : {}),
      ...(restartRequired ? { restartRequired: true } : {}),
    }
  }),
)

export const saveSandboxOption = createFileMutation(async (data) =>
  withWritableServerFiles(async (configPath, serverName, activeServer) => {
    const name = data.name
    const value = data.value
    if (typeof name !== 'string' || !name) {
      fileFailure('Option name required', 400, 'SANDBOX_OPTION_NAME_REQUIRED')
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      fileFailure(
        'Option value must be a primitive',
        400,
        'SANDBOX_OPTION_VALUE_INVALID',
      )
    }
    const parts = name.split('.')
    if (
      parts.length > 2 ||
      !parts.every((part) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part))
    ) {
      fileFailure('Invalid option name', 400, 'SANDBOX_OPTION_NAME_INVALID')
    }

    const { existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { withFileLock, writeFileAtomic } =
      await import('../../../panel-server/utils/fileWriteQueue.ts')
    const { createBackup, backupWarningFor } =
      await import('../../../panel-server/utils/configBackup.ts')
    const { modifySandboxValue } =
      await import('../../../panel-server/services/sandboxPersistence.ts')
    const filePath = join(configPath, fileName(serverName, 'sandbox'))
    if (!existsSync(filePath)) {
      fileFailure(
        'SandboxVars file not found. Start the server once to generate it.',
        404,
        'SANDBOX_OPTION_FILE_NOT_FOUND',
      )
    }

    const block = parts.length === 2 ? parts[0] : null
    const key = parts.length === 2 ? parts[1] : parts[0]
    const restartRequired = await configEditRestartRequired(activeServer)
    let persisted = false
    let backupWarning: string | null = null
    await withFileLock(filePath, async () => {
      const original = readFileSync(filePath, 'utf8')
      const updated = modifySandboxValue(original, key, value, block)
      if (updated === original) return
      backupWarning = backupWarningFor(
        await createBackup(configPath, fileName(serverName, 'sandbox')),
      )
      writeFileAtomic(filePath, updated, 'utf8')
      persisted = true
    })

    return {
      success: true,
      persisted,
      ...(backupWarning ? { backupWarning } : {}),
      ...(restartRequired ? { restartRequired: true } : {}),
    }
  }),
)

export const repairServerSandbox = createFileMutation(async () =>
  withWritableServerFiles(async (configPath, serverName, activeServer) => {
    const { existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { withFileLock, writeFileAtomic } =
      await import('../../../panel-server/utils/fileWriteQueue.ts')
    const { createBackup } =
      await import('../../../panel-server/utils/configBackup.ts')
    const filePath = join(configPath, fileName(serverName, 'sandbox'))
    if (!existsSync(filePath)) {
      fileFailure(
        'SandboxVars file not found',
        404,
        'SANDBOXVARS_FILE_NOT_FOUND',
      )
    }

    const restartRequired = await configEditRestartRequired(activeServer)
    const result = await withFileLock(filePath, async () => {
      const original = readFileSync(filePath, 'utf8')
      if (checkSandboxBalance(original).balanced) {
        return { alreadyValid: true as const }
      }
      const repaired = repairSandboxSyntax(original)
      if (!repaired.fixed) {
        return {
          alreadyValid: false as const,
          repaired: false as const,
          error:
            'Could not automatically repair this file. Restore a backup or fix it manually.',
          code: 'SANDBOX_REPAIR_PATTERN_UNKNOWN',
        }
      }
      const backup = await createBackup(
        configPath,
        fileName(serverName, 'sandbox'),
      )
      if (!backup.backedUp) {
        return {
          alreadyValid: false as const,
          repaired: false as const,
          error: `Could not back up SandboxVars.lua before repairing it, so nothing was changed: ${backup.error}.`,
          code: 'SANDBOX_REPAIR_BACKUP_FAILED',
          params: { reason: backup.error },
        }
      }
      writeFileAtomic(filePath, repaired.content, 'utf8')
      return {
        alreadyValid: false as const,
        repaired: true as const,
        changes: repaired.changes,
        backupName: backup.name,
      }
    })

    if (result.alreadyValid) {
      return {
        success: true,
        alreadyValid: true,
        message: 'SandboxVars.lua is already valid. No repair needed.',
      }
    }
    if (!result.repaired) {
      fileFailure(result.error, 422, result.code, {
        success: false,
        ...(result.params ? { params: result.params } : {}),
      })
    }
    return {
      success: true,
      repaired: true,
      changes: result.changes,
      message: `Repaired ${result.changes.length} issue${result.changes.length === 1 ? '' : 's'} in SandboxVars.lua. A backup of the broken file was saved first (${result.backupName}).`,
      ...(restartRequired ? { restartRequired: true } : {}),
    }
  }),
)

export const saveServerSpawnPoints = createFileMutation(async (data) =>
  withWritableServerFiles(async (configPath, serverName, activeServer) => {
    const spawnpoints = data.spawnpoints
    if (!spawnpoints || typeof spawnpoints !== 'object') {
      fileFailure(
        'Spawn points object required (keyed by profession)',
        400,
        'SPAWNPOINTS_OBJECT_REQUIRED',
      )
    }
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { withFileLock, writeFileAtomic } =
      await import('../../../panel-server/utils/fileWriteQueue.ts')
    const { createBackup, backupWarningFor } =
      await import('../../../panel-server/utils/configBackup.ts')
    const filePath = join(configPath, fileName(serverName, 'spawnpoints'))
    const restartRequired = await configEditRestartRequired(activeServer)
    let backupWarning: string | null = null
    await withFileLock(filePath, async () => {
      if (existsSync(filePath)) {
        backupWarning = backupWarningFor(
          await createBackup(configPath, fileName(serverName, 'spawnpoints')),
        )
      }
      writeFileAtomic(filePath, toSpawnPoints(spawnpoints as AnyRecord), 'utf8')
    })
    return {
      success: true,
      message: 'Spawn points saved',
      ...(backupWarning ? { backupWarning } : {}),
      ...(restartRequired ? { restartRequired: true } : {}),
    }
  }),
)

export const saveServerSpawnRegions = createFileMutation(async (data) =>
  withWritableServerFiles(async (configPath, serverName, activeServer) => {
    const spawnregions = data.spawnregions
    if (!Array.isArray(spawnregions)) {
      fileFailure(
        'Spawn regions array required',
        400,
        'SPAWNREGIONS_ARRAY_REQUIRED',
      )
    }
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { withFileLock, writeFileAtomic } =
      await import('../../../panel-server/utils/fileWriteQueue.ts')
    const { createBackup, backupWarningFor } =
      await import('../../../panel-server/utils/configBackup.ts')
    const filePath = join(configPath, fileName(serverName, 'spawnregions'))
    const restartRequired = await configEditRestartRequired(activeServer)
    let backupWarning: string | null = null
    await withFileLock(filePath, async () => {
      if (existsSync(filePath)) {
        backupWarning = backupWarningFor(
          await createBackup(configPath, fileName(serverName, 'spawnregions')),
        )
      }
      writeFileAtomic(filePath, toSpawnRegions(spawnregions), 'utf8')
    })
    return {
      success: true,
      message: 'Spawn regions saved',
      ...(backupWarning ? { backupWarning } : {}),
      ...(restartRequired ? { restartRequired: true } : {}),
    }
  }),
)

export const saveServerRawFile = createFileMutation(async (data) =>
  withWritableServerFiles(async (configPath, serverName, activeServer) => {
    const type = String(data.type)
    if (!['ini', 'sandbox', 'spawnpoints', 'spawnregions'].includes(type)) {
      fileFailure('Invalid file type', 400, 'RAW_FILE_INVALID_TYPE')
    }
    const content = data.content
    if (typeof content !== 'string') {
      fileFailure('Content string required', 400, 'RAW_CONTENT_STRING_REQUIRED')
    }
    if (content.length > 512 * 1024) {
      fileFailure('Content too large (max 512KB)', 400, 'RAW_CONTENT_TOO_LARGE')
    }

    const { existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { withFileLock, writeFileAtomic } =
      await import('../../../panel-server/utils/fileWriteQueue.ts')
    const { backupWarningFor, createBackup, writeIniWithBackup } =
      await import('../../../panel-server/utils/configBackup.ts')
    const sanitize = await import('../../../panel-server/utils/sanitize.ts')
    const filename = fileName(serverName, type as FileType)
    const filePath = join(configPath, filename)
    const restartRequired = await configEditRestartRequired(activeServer)
    let backupWarning: string | null = null
    const reconcileFailure = { value: null as MaskedIniFailure | null }

    await withFileLock(filePath, async () => {
      let contentToWrite = content
      if (type === 'ini' && existsSync(filePath)) {
        const reconciled = reconcileMaskedIniLines(
          content,
          readFileSync(filePath, 'utf8'),
          sanitize,
        )
        if (!reconciled.ok) {
          reconcileFailure.value = reconciled
          return
        }
        contentToWrite = reconciled.content
      }
      if (type === 'ini') {
        backupWarning = backupWarningFor(
          await writeIniWithBackup(filePath, contentToWrite),
        )
      } else {
        if (existsSync(filePath)) {
          backupWarning = backupWarningFor(
            await createBackup(configPath, filename),
          )
        }
        writeFileAtomic(filePath, contentToWrite, 'utf8')
      }
    })

    const failure = reconcileFailure.value
    if (failure) {
      const removed = failure.reason === 'removed'
      fileFailure(
        removed
          ? `The "${failure.key}" line was removed, but it holds a live secret that cannot be silently dropped. To clear it, write "${failure.key}=" explicitly instead of deleting the line, or use the structured editor.`
          : `Could not safely save. The "${failure.key}" line's masked value could not be matched back to exactly one live value. Nothing was written.`,
        400,
        removed ? 'RAW_INI_SECRET_LINE_REMOVED' : 'RAW_INI_SECRET_UNRESOLVABLE',
        { params: { key: failure.key } },
      )
    }

    return {
      success: true,
      message: 'File saved',
      ...(backupWarning ? { backupWarning } : {}),
      ...(restartRequired ? { restartRequired: true } : {}),
    }
  }),
)

export const restoreServerConfigBackup = createFileMutation(async (data) =>
  withWritableServerFiles(async (configPath, _serverName, activeServer) => {
    const { basename, join } = await import('node:path')
    const { access, readFile } = await import('node:fs/promises')
    const { withFileLock, writeFileAtomic } =
      await import('../../../panel-server/utils/fileWriteQueue.ts')
    const { createBackup } =
      await import('../../../panel-server/utils/configBackup.ts')
    const filename = basename(String(data.filename ?? ''))
    if (!filename.endsWith('.bak')) {
      fileFailure(
        'Invalid backup file extension',
        400,
        'RESTORE_INVALID_EXTENSION',
      )
    }
    const backupDir = join(configPath, 'backups')
    const backupPath = join(backupDir, filename)
    const fileExists = async (filePath: string) => {
      try {
        await access(filePath)
        return true
      } catch {
        return false
      }
    }
    if (!(await fileExists(backupPath))) {
      fileFailure('Backup not found', 404, 'RESTORE_BACKUP_NOT_FOUND')
    }
    if (filename.split('.').length < 3) {
      fileFailure('Invalid backup filename', 400, 'RESTORE_INVALID_FILENAME')
    }
    const bakIndex = filename.lastIndexOf('.bak')
    const timestampStart = filename.lastIndexOf('.', bakIndex - 1)
    const originalName = filename.substring(0, timestampStart)
    if (
      !originalName ||
      originalName === '.' ||
      originalName === '..' ||
      originalName.includes('/') ||
      originalName.includes('\\')
    ) {
      fileFailure(
        'Invalid backup filename',
        400,
        'RESTORE_INVALID_ORIGINAL_NAME',
      )
    }

    await requireConfigServerStopped(activeServer)
    const backupData = await readFile(backupPath)
    const targetPath = join(configPath, originalName)
    let preRestoreBackupWarning: string | null = null
    await withFileLock(targetPath, async () => {
      if (await fileExists(targetPath)) {
        const backup = await createBackup(configPath, originalName)
        if (!backup.backedUp && backup.reason !== 'no-source') {
          preRestoreBackupWarning = `Could not back up the current ${originalName} before restoring over it: ${backup.error}.`
        }
      }
      writeFileAtomic(targetPath, backupData)
    })
    return {
      success: true,
      message: `Restored ${originalName} from backup`,
      ...(preRestoreBackupWarning
        ? { backupWarning: preRestoreBackupWarning }
        : {}),
    }
  }),
)

export const saveServerAndReload = createFileMutation(async () => {
  await resolveServerFiles()
  const runtime = await panelRuntime()
  const rconService = runtime.rconService as AnyRecord | undefined
  if (
    !rconService ||
    typeof rconService.isConnected !== 'function' ||
    !rconService.isConnected()
  ) {
    fileFailure(
      'RCON not connected. Changes saved but not reloaded.',
      400,
      'SAVE_AND_RELOAD_RCON_NOT_CONNECTED',
    )
  }
  const result = await rconService.reloadOptions()
  if (!result?.success) {
    return {
      success: false,
      error: result?.error || 'Failed to reload options via RCON',
      result,
    }
  }
  return { success: true, message: 'Options reloaded', result }
})
