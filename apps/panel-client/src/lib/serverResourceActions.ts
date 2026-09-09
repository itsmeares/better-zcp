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

function throwResourceError(error: unknown, fallbackStatus = 500): never {
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
  throwResourceError(
    Object.assign(new Error(message), code ? { code } : {}),
    400,
  )
}

function capabilityMiddleware(capability?: string) {
  return capability
    ? ([
        ...protectedServerFunctionMiddleware,
        permissionMiddleware(capability),
      ] as const)
    : protectedServerFunctionMiddleware
}

function createResourceAction<T>(
  capability: string | undefined,
  handler: (data: AnyRecord) => Promise<T> | T,
) {
  return createServerFn({ method: 'POST' })
    .middleware(capabilityMiddleware(capability))
    .validator((data: unknown) => record(data))
    .handler(async ({ data }) => {
      try {
        return (await handler(data)) as any
      } catch (error) {
        throwResourceError(error)
      }
    })
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

export const createTemplate = createResourceAction(
  'templates.manage',
  async (data) => {
    const { saveTemplate } =
      await import('../../../panel-server/services/templateService.ts')
    const result = await saveTemplate(data)
    if (!result.success) throwResourceError(result, 400)
    return result
  },
)

export const importTemplate = createResourceAction(
  'templates.manage',
  async (data) => {
    const { importTemplate: importTemplateService } =
      await import('../../../panel-server/services/templateService.ts')
    const result = await importTemplateService(data.template ?? data)
    if (!result.success) throwResourceError(result, 400)
    return result
  },
)

export const previewTemplate = createResourceAction(undefined, async (data) => {
  if (!data.serverId)
    invalid('serverId is required', 'SIM_TEMPLATE_SERVER_ID_REQUIRED')
  const { previewTemplate: previewTemplateService } =
    await import('../../../panel-server/services/templateService.ts')
  const result = await previewTemplateService(
    String(data.id ?? ''),
    String(data.serverId),
  )
  if (!result.success) throwResourceError(result, 400)
  return result
})

export const applyTemplate = createResourceAction(
  'templates.manage',
  async (data) => {
    if (!data.serverId)
      invalid('serverId is required', 'SIM_TEMPLATE_SERVER_ID_REQUIRED')

    const [{ getActiveServer }, { ErrorCode }] = await Promise.all([
      import('../../../panel-server/database/init.ts'),
      import('../../../panel-server/utils/errorCodes.ts'),
    ])
    const runtime = await panelRuntime()
    const activeServer = await getActiveServer()
    if (String(activeServer?.id) !== String(data.serverId)) {
      throwResourceError(
        Object.assign(
          new Error(
            "Can't verify this server's running state — the panel can only check the currently active server. Switch to this server first, then apply the template.",
          ),
          { code: ErrorCode.SIM_TEMPLATE_APPLY_INACTIVE_SERVER_UNVERIFIABLE },
        ),
        409,
      )
    }

    const serverManager = runtime.serverManager
    if (!serverManager?.getServerProcessDetails) {
      throwResourceError(
        Object.assign(new Error('Unable to verify server state'), {
          code: ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
        }),
        503,
      )
    }

    try {
      const details = await serverManager.getServerProcessDetails()
      if (details.scanFailed) {
        throwResourceError(
          Object.assign(new Error('Unable to verify server state'), {
            code: ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
          }),
          503,
        )
      }
      if (details.running) {
        throwResourceError(
          Object.assign(
            new Error('Stop the server before applying a template'),
            {
              code: ErrorCode.SIM_TEMPLATE_APPLY_SERVER_RUNNING,
            },
          ),
          409,
        )
      }
    } catch (error) {
      if (
        error instanceof Error &&
        typeof (error as Error & { status?: unknown }).status === 'number'
      ) {
        throw error
      }
      throwResourceError(
        Object.assign(new Error('Unable to verify server state'), {
          code: ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
        }),
        503,
      )
    }

    const { applyTemplate: applyTemplateService } =
      await import('../../../panel-server/services/templateService.ts')
    const options =
      data.options &&
      typeof data.options === 'object' &&
      !Array.isArray(data.options)
        ? data.options
        : {}
    const result = await applyTemplateService(
      String(data.id ?? ''),
      String(data.serverId),
      options,
    )
    if (!result.success) throwResourceError(result, 400)
    return result
  },
)

export const deleteTemplate = createResourceAction(
  'templates.manage',
  async (data) => {
    const { deleteTemplate: deleteTemplateService } =
      await import('../../../panel-server/services/templateService.ts')
    const result = await deleteTemplateService(String(data.id ?? ''))
    if (!result.success) throwResourceError(result, 400)
    return result
  },
)

export const unhideTemplate = createResourceAction(
  'templates.manage',
  async (data) => {
    const { unhideTemplate: unhideTemplateService } =
      await import('../../../panel-server/services/templateService.ts')
    const result = await unhideTemplateService(String(data.id ?? ''))
    if (!result.success) throwResourceError(result, 400)
    return result
  },
)

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

export const updateBackupSettings = createResourceAction(
  'backups.manage',
  async (data) => {
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
  },
)

export const deleteBackup = createResourceAction(
  'backups.manage',
  async (data) => {
    const runtime = await panelRuntime()
    const result = await runtime.backupService.deleteBackup(
      String(data.name ?? ''),
    )
    if (!result.success) throwResourceError(result, 400)
    return result
  },
)

export const deleteBackupsOlderThan = createResourceAction(
  'backups.manage',
  async (data) => {
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
  },
)

export const createBackup = createResourceAction(
  'backups.manage',
  async (data) => {
    const { getActiveServer } =
      await import('../../../panel-server/database/init.ts')
    const { ErrorCode } =
      await import('../../../panel-server/utils/errorCodes.ts')
    const activeServer = await getActiveServer()
    if (activeServer?.isRemote) {
      throwResourceError(
        Object.assign(
          new Error(
            'Backups are not available for remote servers. The server filesystem is not accessible from this panel.',
          ),
          { code: ErrorCode.BACKUP_REMOTE_NOT_AVAILABLE },
        ),
        400,
      )
    }

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
  },
)

export const restoreBackup = createResourceAction(
  'backups.restore',
  async (data) => {
    const [
      { getActiveServer },
      { acquireLifecycleLock, lifecycleInProgressResponse },
      { ErrorCode },
      pathModule,
    ] = await Promise.all([
      import('../../../panel-server/database/init.ts'),
      import('../../../panel-server/services/lifecycleCoordinator.ts'),
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
      if (activeServerForLock?.isRemote) {
        throwResourceError(
          Object.assign(
            new Error(
              'Backup restore is not available for remote servers. The server filesystem is not accessible from this panel.',
            ),
            { code: ErrorCode.BACKUP_RESTORE_REMOTE_NOT_AVAILABLE },
          ),
          400,
        )
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

      const processDetails =
        await runtime.serverManager.getServerProcessDetails()
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
        : (
            await import('../../../panel-server/utils/sanitize.ts')
          ).sanitizeError(result.message)
      throwResourceError(new Error(message || 'Backup restore failed'), 400)
    } finally {
      lifecycleLock.release()
    }
  },
)
