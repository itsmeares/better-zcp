import { createServerFn } from '@tanstack/react-start'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

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

function capabilityMiddleware(capability: string) {
  return [
    ...protectedServerFunctionMiddleware,
    permissionMiddleware(capability),
  ] as const
}

function createResourceRead<T>(
  capability: string | undefined,
  handler: (data: AnyRecord) => Promise<T> | T,
) {
  const serverFn = createServerFn({ method: 'GET' })
  const secured = capability
    ? serverFn.middleware(capabilityMiddleware(capability))
    : serverFn

  return secured
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

function playerName(data: AnyRecord): string {
  const value = data.playerName
  if (typeof value !== 'string' || !value) invalid('Player name is required')
  return value
}

export const getPlayerActivity = createResourceRead(
  'players.view',
  async (data) => {
    const { getPlayerLogs } =
      await import('../../../panel-server/database/init.ts')
    const { parseClampedInteger } =
      await import('../../../panel-server/utils/queryNumbers.ts')
    const player = typeof data.player === 'string' ? data.player : null
    const limit = parseClampedInteger(data.limit, 100, 1, 500)
    return {
      success: true,
      logs: await getPlayerLogs(player, limit),
    }
  },
)

export const getPlayerNotes = createResourceRead(
  'players.view',
  async () => {
    const { getPlayerNotes } =
      await import('../../../panel-server/database/init.ts')
    return { success: true, notes: await getPlayerNotes() }
  },
)

export const getPlayerNote = createResourceRead(
  'players.view',
  async (data) => {
    const { getPlayerNote } =
      await import('../../../panel-server/database/init.ts')
    return { success: true, note: await getPlayerNote(playerName(data)) }
  },
)

export const getPlayerStats = createResourceRead(
  'players.view',
  async () => {
    const { getPlayerStats } =
      await import('../../../panel-server/database/init.ts')
    return { success: true, stats: await getPlayerStats() }
  },
)

export const getPlayerStat = createResourceRead(
  'players.view',
  async (data) => {
    const { getPlayerStat } =
      await import('../../../panel-server/database/init.ts')
    return { success: true, stat: await getPlayerStat(playerName(data)) }
  },
)

export const getBackupStatus = createResourceRead(
  undefined,
  async () => (await panelRuntime()).backupService.getStatus(),
)

export const getBackupInfo = createResourceRead(
  undefined,
  async () => (await panelRuntime()).backupService.getBackupContentsInfo(),
)

export const getBackups = createResourceRead(
  undefined,
  async () => ({
    backups: await (await panelRuntime()).backupService.listBackups(),
  }),
)

export const getBackupSnapshot = createResourceRead(
  'backups.manage',
  async (data) => {
    const result = await (
      await panelRuntime()
    ).backupService.getBackupSnapshot(String(data.name ?? ''))
    if (!result.success) {
      throwResourceError(
        new Error(result.message || 'Could not read backup snapshot'),
        404,
      )
    }
    return result
  },
)

export const getBackupHistory = createResourceRead(
  undefined,
  async (data) => {
    const { parseClampedInteger } =
      await import('../../../panel-server/utils/queryNumbers.ts')
    const { listBackupRecords } =
      await import('../../../panel-server/services/backupRecords.ts')
    let limit: number | undefined
    if (data.limit !== undefined) {
      const parsed = parseClampedInteger(data.limit, null, 1, 500)
      if (parsed === null) invalid('Invalid history limit')
      limit = parsed
    }
    const serverId =
      typeof data.serverId === 'string' || typeof data.serverId === 'number'
        ? data.serverId
        : undefined
    return { records: await listBackupRecords({ serverId, limit }) }
  },
)

export const getTemplates = createResourceRead(
  undefined,
  async () => {
    const { listTemplates } =
      await import('../../../panel-server/services/templateService.ts')
    return { templates: await listTemplates() }
  },
)

export const getTemplate = createResourceRead(
  undefined,
  async (data) => {
    const id = String(data.id ?? '')
    const { getTemplate } =
      await import('../../../panel-server/services/templateService.ts')
    const template = await getTemplate(id)
    if (!template) {
      throwResourceError(
        Object.assign(new Error('Template not found'), {
          code: 'SIM_TEMPLATE_NOT_FOUND',
        }),
        404,
      )
    }
    return { template }
  },
)

export const exportTemplate = createResourceRead(
  undefined,
  async (data) => {
    const { exportTemplate } =
      await import('../../../panel-server/services/templateService.ts')
    const result = await exportTemplate(String(data.id ?? ''))
    if (!result.success) throwResourceError(result, 404)
    return result.template
  },
)

export const getHiddenTemplates = createResourceRead(
  'templates.manage',
  async () => {
    const { listHiddenBuiltinTemplates } =
      await import('../../../panel-server/services/templateService.ts')
    return { templates: await listHiddenBuiltinTemplates() }
  },
)
