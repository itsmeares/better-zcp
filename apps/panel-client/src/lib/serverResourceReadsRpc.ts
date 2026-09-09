import { createServerFn } from '@tanstack/react-start'
import {
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

export const getBackupSnapshot = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('backups.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getBackupSnapshot', { data, context }),
  )

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
