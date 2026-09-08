import { createServerFn } from '@tanstack/react-start'
import {
  getProtectedApiJson,
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

type AnyRecord = Record<string, any>

type ExecuteOptions = {
  data?: unknown
  context?: unknown
}

type ImplementationFunction = {
  __executeServer?: (
    options: ExecuteOptions,
  ) => Promise<{ result?: unknown; error?: unknown }>
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function capabilityMiddleware(capability: string) {
  return [
    ...protectedServerFunctionMiddleware,
    permissionMiddleware(capability),
  ] as const
}

async function invoke(name: string, options: ExecuteOptions): Promise<any> {
  const implementation = await import('./serverResourceReads')
  const serverFunction = implementation[
    name as keyof typeof implementation
  ] as unknown as ImplementationFunction | undefined
  const executeServer = serverFunction?.__executeServer
  if (!executeServer)
    throw new Error(`Server function ${name} is not available`)
  const outcome = await executeServer(options)
  if (outcome.error) throw outcome.error
  return outcome.result
}

export const getPlayerActivity = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getPlayerActivity', { data, context }),
  )

export const getPlayerNotes = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getPlayerNotes', { data, context }))

export const getPlayerNote = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getPlayerNote', { data, context }))

export const getPlayerStats = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getPlayerStats', { data, context }))

export const getPlayerStat = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getPlayerStat', { data, context }))

export const getBackupStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getBackupStatus', { data, context }))

export const getBackupInfo = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getBackupInfo', { data, context }))

export const getBackups = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getBackups', { data, context }))

export const getBackupHistory = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getBackupHistory', { data, context }),
  )

export const getTemplates = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getTemplates', { data, context }))

export const getTemplate = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getTemplate', { data, context }))

export const exportTemplate = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('exportTemplate', { data, context }),
  )

export const getHiddenTemplates = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('templates.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getHiddenTemplates', { data, context }),
  )

async function withFallback<T>(
  operation: () => Promise<T>,
  endpoint: string,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const result = await operation()
    if (result === undefined) throw new Error('Server function unavailable')
    return result
  } catch {
    return getProtectedApiJson<T>(endpoint, signal)
  }
}

export function getPlayerActivityWithFallback(
  player?: string,
  limit?: number,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (player) query.set('player', player)
  if (limit !== undefined) query.set('limit', String(limit))
  return withFallback(
    () => getPlayerActivity({ data: { player, limit } }),
    `/players/activity?${query.toString()}`,
    signal,
  )
}

export function getPlayerNotesWithFallback(signal?: AbortSignal) {
  return withFallback(() => getPlayerNotes(), '/players/notes', signal)
}

export function getPlayerNoteWithFallback(
  playerName: string,
  signal?: AbortSignal,
) {
  return withFallback(
    () => getPlayerNote({ data: { playerName } }),
    `/players/notes/${encodeURIComponent(playerName)}`,
    signal,
  )
}

export function getPlayerStatsWithFallback(signal?: AbortSignal) {
  return withFallback(() => getPlayerStats(), '/players/stats', signal)
}

export function getPlayerStatWithFallback(
  playerName: string,
  signal?: AbortSignal,
) {
  return withFallback(
    () => getPlayerStat({ data: { playerName } }),
    `/players/stats/${encodeURIComponent(playerName)}`,
    signal,
  )
}

export function getBackupStatusWithFallback(signal?: AbortSignal) {
  return withFallback(() => getBackupStatus(), '/backup/status', signal)
}

export function getBackupInfoWithFallback(signal?: AbortSignal) {
  return withFallback(() => getBackupInfo(), '/backup/info', signal)
}

export function getBackupsWithFallback(signal?: AbortSignal) {
  return withFallback(() => getBackups(), '/backup/list', signal)
}

export function getBackupHistoryWithFallback(
  serverId?: string | number,
  signal?: AbortSignal,
) {
  const endpoint =
    serverId === undefined
      ? '/backup/history'
      : `/backup/history?serverId=${encodeURIComponent(String(serverId))}`
  return withFallback(
    () => getBackupHistory({ data: { serverId } }),
    endpoint,
    signal,
  )
}

export function getTemplatesWithFallback(signal?: AbortSignal) {
  return withFallback(() => getTemplates(), '/templates', signal)
}

export function getTemplateWithFallback(id: string, signal?: AbortSignal) {
  return withFallback(
    () => getTemplate({ data: { id } }),
    `/templates/${encodeURIComponent(id)}`,
    signal,
  )
}

export function exportTemplateWithFallback(id: string, signal?: AbortSignal) {
  return withFallback(
    () => exportTemplate({ data: { id } }),
    `/templates/${encodeURIComponent(id)}/export`,
    signal,
  )
}

export function getHiddenTemplatesWithFallback(signal?: AbortSignal) {
  return withFallback(
    () => getHiddenTemplates(),
    '/templates/hidden',
    signal,
  )
}
