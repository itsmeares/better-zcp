import { createServerFn } from '@tanstack/react-start'
import { protectedServerFunctionMiddleware } from './serverAuth.server'

type AnyRecord = Record<string, any>
type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  params?: unknown
  status?: unknown
  success?: unknown
  valid?: unknown
  detail?: unknown
  reason?: unknown
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

function throwResourceError(error: unknown, fallbackStatus = 500): never {
  const details =
    error && typeof error === 'object' ? (error as ServiceError) : {}
  const status =
    typeof details.status === 'number' ? details.status : fallbackStatus
  throw Object.assign(new Error(errorMessage(error)), {
    status,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(details.params !== undefined ? { params: details.params } : {}),
    ...(details.success === false ? { success: false } : {}),
    ...(details.valid === false ? { valid: false } : {}),
    ...(typeof details.detail === 'string' ? { detail: details.detail } : {}),
    ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
  })
}

function invalid(message: string, code?: string): never {
  throwResourceError(
    Object.assign(new Error(message), code ? { code } : {}),
    400,
  )
}

function createResourceAction<T>(handler: (data: AnyRecord) => Promise<T> | T) {
  const implementation = async (data: AnyRecord): Promise<T> => {
    try {
      return (await handler(data)) as T
    } catch (error) {
      throwResourceError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'POST' })
      .middleware(protectedServerFunctionMiddleware)
      .validator((data: unknown) => record(data))
      .handler(({ data }) => implementation(data) as any),
    { __executeImplementation: implementation },
  )
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

function validPlayerName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 64 &&
    // eslint-disable-next-line no-control-regex
    /^[^\x00-\x1F\x7F"\\]+$/.test(value.trim())
  )
}

export const upsertPlayerNote = createResourceAction(async (data) => {
    const playerName = data.playerName
    if (!playerName) {
      invalid('Player name is required', 'PLAYERS_NOTE_PLAYER_NAME_REQUIRED')
    }
    if (!validPlayerName(playerName)) {
      invalid('Invalid player name format', 'PLAYERS_INVALID_NOTE_PLAYER_NAME')
    }
    const note = data.note
    if (note !== undefined && note !== null && typeof note !== 'string') {
      invalid('Note must be text', 'PLAYERS_NOTE_MUST_BE_TEXT')
    }
    if (typeof note === 'string' && note.length > 10000) {
      invalid('Note too long (max 10000 characters)', 'PLAYERS_NOTE_TOO_LONG')
    }
    const tags = data.tags || []
    if (!Array.isArray(tags)) {
      invalid('Tags must be an array', 'PLAYERS_NOTE_TAGS_MUST_BE_ARRAY')
    }
    if (tags.some((tag) => typeof tag !== 'string' || tag.length > 50)) {
      invalid(
        'Tags must be strings (max 50 chars each)',
        'PLAYERS_NOTE_INVALID_TAGS',
      )
    }
    const { upsertPlayerNote } =
      await import('../../../panel-server/database/init.ts')
    return {
      success: true,
      note: await upsertPlayerNote(String(playerName), note, tags),
    }
})

export const deletePlayerNote = createResourceAction(async (data) => {
    const { deletePlayerNote } =
      await import('../../../panel-server/database/init.ts')
    const success = await deletePlayerNote(String(data.playerName ?? ''))
    if (!success) {
      throwResourceError(
        Object.assign(new Error('Player note not found'), {
          success: false,
          code: 'PLAYERS_NOTE_NOT_FOUND',
          status: 404,
        }),
        404,
      )
    }
    return { success }
})

export const deletePlayerExport = createResourceAction(async (data) => {
    const { deletePlayerExport: removePlayerExport } =
      await import('../../../panel-server/services/playerExports.ts')
    removePlayerExport(String(data.username ?? ''), String(data.filename ?? ''))
    return { success: true }
})

function parseBackupBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return undefined
}

function parseBackupMaxCount(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : undefined
}

export const updateBackupSettings = createResourceAction(async (data) => {
    const { isCronTooFrequent, isSupportedFiveFieldCron } =
      await import('../../../panel-server/utils/cronValidation.ts')
    const allowed: AnyRecord = {}
    if (data.enabled !== undefined) {
      const enabled = parseBackupBoolean(data.enabled)
      if (enabled === undefined) invalid('enabled must be a boolean or 0/1')
      allowed.enabled = enabled
    }
    if (data.schedule !== undefined) {
      if (
        typeof data.schedule !== 'string' ||
        !isSupportedFiveFieldCron(data.schedule) ||
        isCronTooFrequent(data.schedule)
      ) {
        invalid(
          'Invalid backup schedule. Use exactly 5 cron fields and no more than one run every 5 minutes.',
        )
      }
      allowed.schedule = data.schedule.trim()
    }
    if (data.maxBackups !== undefined) {
      const maxBackups = parseBackupMaxCount(data.maxBackups)
      if (maxBackups === undefined)
        invalid('maxBackups must be an integer between 1 and 100')
      allowed.maxBackups = maxBackups
    }
    if (data.includeDb !== undefined) {
      const includeDb = parseBackupBoolean(data.includeDb)
      if (includeDb === undefined) invalid('includeDb must be a boolean or 0/1')
      allowed.includeDb = includeDb
    }

    const runtime = await panelRuntime()
    const settings = await runtime.backupService.updateSettings(allowed)
    if (runtime.scheduler?.setupBackupSchedule)
      await runtime.scheduler.setupBackupSchedule()
    return { success: true, settings }
})

export const deleteBackup = createResourceAction(async (data) => {
    const runtime = await panelRuntime()
    const result = await runtime.backupService.deleteBackup(
      String(data.name ?? ''),
    )
    if (!result.success) throwResourceError(result, 400)
    return result
})

export const deleteBackupsOlderThan = createResourceAction(async (data) => {
    if (
      typeof data.days !== 'number' ||
      !Number.isInteger(data.days) ||
      data.days < 1
    )
      invalid(
        'Invalid days parameter. Must be a whole number >= 1',
        'BACKUP_INVALID_DAYS_PARAMETER',
      )
    const runtime = await panelRuntime()
    return runtime.backupService.deleteBackupsOlderThan(data.days)
})

export const createBackup = createResourceAction(async (data) => {
    const runtime = await panelRuntime()
    const result = await runtime.backupService.createBackup({
      includeDb: data.includeDb === true,
      io: runtime.io,
    })
    if (!result.success) throwResourceError(result, 400)
    if (result.skippedFiles?.length > 0) {
      return {
        ...result,
        warnings: [
          `${result.skippedFiles.length} file(s) could not be included in the backup: ${result.skippedFiles.join(', ')}. This is usually a temp, log, or lock file the running server rewrote mid-backup, or a symbolic link that was deliberately not followed -- check that the backup still restores correctly if any of these look like save data.`,
        ],
      }
    }
    return result
})

export const restoreBackup = createResourceAction(async (data) => {
    const [
      { getActiveServer },
      { acquireLifecycleLock, lifecycleInProgressResponse },
      { hasActiveSteamOperation },
      { ErrorCode },
      pathModule,
    ] = await Promise.all([
      import('../../../panel-server/database/init.ts'),
      import('../../../panel-server/services/lifecycleCoordinator.ts'),
      import('../../../panel-server/services/activeSteamOperations.ts'),
      import('../../../panel-server/utils/errorCodes.ts'),
      import('node:path'),
    ])
    const activeServerForLock = await getActiveServer()
    const lifecycleLock = acquireLifecycleLock(
      'restore',
      activeServerForLock?.name || activeServerForLock?.serverName || null,
    )
    if (!lifecycleLock) {
      throwResourceError(lifecycleInProgressResponse(), 409)
    }

    try {
      if (activeServerForLock?.installPath) {
        const normalizedRestoreTargetPath = pathModule
          .normalize(activeServerForLock.installPath)
          .toLowerCase()
        if (hasActiveSteamOperation(normalizedRestoreTargetPath)) {
          throwResourceError(
            Object.assign(
              new Error(
                'A Steam operation is already in progress for this path. Please wait for it to complete.',
              ),
              { code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH },
            ),
            409,
          )
        }
      }

      const runtime = await panelRuntime()
      const safeName = pathModule.basename(String(data.name ?? ''))
      if (!safeName.endsWith('.zip')) {
        throwResourceError(
          Object.assign(new Error('Invalid backup file'), {
            code: ErrorCode.BACKUP_INVALID_FILE,
          }),
          400,
        )
      }

    const processDetails = await runtime.serverManager.getServerProcessDetails()
      if (processDetails.scanFailed) {
        throwResourceError(
          Object.assign(
            new Error(
              "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
            ),
            { code: ErrorCode.SERVER_STATE_UNKNOWN },
          ),
          503,
        )
      }
      if (processDetails.running) {
        throwResourceError(
          Object.assign(
            new Error(
              'Server must be stopped before restoring a backup. Please stop the server first.',
            ),
            { code: ErrorCode.BACKUP_RESTORE_SERVER_RUNNING },
          ),
          400,
        )
      }

      const options =
        data.options &&
        typeof data.options === 'object' &&
        !Array.isArray(data.options)
          ? data.options
          : {}
      const result = await runtime.backupService.restoreBackup(safeName, {
        ...options,
        io: runtime.io,
      })
      if (result.success) return result

      const isRollbackFailureMessage =
        typeof result.message === 'string' &&
        result.message.startsWith(
          'Restore failed and the previous save could not be put back automatically.',
        )
      const message = isRollbackFailureMessage
        ? result.message
      : (await import('../../../panel-server/utils/sanitize.ts')).sanitizeError(
          result.message,
        )
      throwResourceError(new Error(message || 'Backup restore failed'), 400)
    } finally {
      lifecycleLock.release()
    }
})
