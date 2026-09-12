import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverResourceReads.server'
import { invokeServerFunction } from './serverFunctionRpc'
type AnyRecord = Record<string, any>

type ExecuteOptions = {
  data?: unknown
  context?: unknown
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function invoke(
  serverFunction: unknown,
  name: string,
  options: ExecuteOptions,
): Promise<any> {
  return invokeServerFunction(serverFunction, name, options)
}

export const getPlayerActivity = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getPlayerActivity, 'getPlayerActivity', {
      data,
      context,
    }),
  )

export const getPlayerNotes = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getPlayerNotes, 'getPlayerNotes', {
      data,
      context,
    }),
  )

export const getPlayerNote = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getPlayerNote, 'getPlayerNote', {
      data,
      context,
    }),
  )

export const getPlayerStats = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getPlayerStats, 'getPlayerStats', {
      data,
      context,
    }),
  )

export const getPlayerStat = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getPlayerStat, 'getPlayerStat', {
      data,
      context,
    }),
  )

export const getBackupStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getBackupStatus, 'getBackupStatus', {
      data,
      context,
    }),
  )

export const getBackupInfo = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getBackupInfo, 'getBackupInfo', {
      data,
      context,
    }),
  )

export const getBackups = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getBackups, 'getBackups', { data, context }),
  )

export const getBackupSnapshot = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getBackupSnapshot, 'getBackupSnapshot', {
      data,
      context,
    }),
  )

export const getBackupHistory = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getBackupHistory, 'getBackupHistory', {
      data,
      context,
    }),
  )

export const getTemplates = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getTemplates, 'getTemplates', {
      data,
      context,
    }),
  )

export const getTemplate = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getTemplate, 'getTemplate', { data, context }),
  )

export const exportTemplate = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.exportTemplate, 'exportTemplate', {
      data,
      context,
    }),
  )

export const getHiddenTemplates = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getHiddenTemplates, 'getHiddenTemplates', {
      data,
      context,
    }),
  )
