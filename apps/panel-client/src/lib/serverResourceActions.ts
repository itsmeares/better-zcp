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
