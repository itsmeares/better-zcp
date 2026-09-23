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

function createResourceRead<T>(handler: (data: AnyRecord) => Promise<T> | T) {
  const implementation = async (data: AnyRecord): Promise<T> => {
    try {
      return (await handler(data)) as T
    } catch (error) {
      throwResourceError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'GET' })
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

function playerName(data: AnyRecord): string {
  const value = data.playerName
  if (typeof value !== 'string' || !value) invalid('Player name is required')
  return value
}

export const getPlayerActivity = createResourceRead(async (data) => {
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
})

export const getPlayerNotes = createResourceRead(async () => {
  const { getPlayerNotes } =
    await import('../../../panel-server/database/init.ts')
  return { success: true, notes: await getPlayerNotes() }
})

export const getPlayerNote = createResourceRead(async (data) => {
    const { getPlayerNote } =
      await import('../../../panel-server/database/init.ts')
    return { success: true, note: await getPlayerNote(playerName(data)) }
})

export const getPlayerStats = createResourceRead(async () => {
  const { getPlayerStats } =
    await import('../../../panel-server/database/init.ts')
  return { success: true, stats: await getPlayerStats() }
})

export const getPlayerStat = createResourceRead(async (data) => {
    const { getPlayerStat } =
      await import('../../../panel-server/database/init.ts')
    return { success: true, stat: await getPlayerStat(playerName(data)) }
})

export const getBackupStatus = createResourceRead(async () =>
  (await panelRuntime()).backupService.getStatus(),
)

export const getBackupInfo = createResourceRead(async () =>
  (await panelRuntime()).backupService.getBackupContentsInfo(),
)

export const getBackups = createResourceRead(async () => ({
    backups: await (await panelRuntime()).backupService.listBackups(),
}))

export const getBackupSnapshot = createResourceRead(async (data) => {
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
})

export const getBackupHistory = createResourceRead(async (data) => {
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
})
