import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverResourceActions.server'
import { invokeServerFunction } from './serverFunctionRpc'
type AnyRecord = Record<string, any>
type ExecuteOptions = { data?: unknown; context?: unknown }
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

export const createTemplate = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.createTemplate, 'createTemplate', {
      data,
      context,
    }),
  )

export const importTemplate = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.importTemplate, 'importTemplate', {
      data,
      context,
    }),
  )

export const previewTemplate = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.previewTemplate, 'previewTemplate', {
      data,
      context,
    }),
  )

export const applyTemplate = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.applyTemplate, 'applyTemplate', {
      data,
      context,
    }),
  )

export const deleteTemplate = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.deleteTemplate, 'deleteTemplate', {
      data,
      context,
    }),
  )

export const unhideTemplate = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.unhideTemplate, 'unhideTemplate', {
      data,
      context,
    }),
  )

export const updateBackupSettings = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.updateBackupSettings, 'updateBackupSettings', {
      data,
      context,
    }),
  )

export const deleteBackup = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.deleteBackup, 'deleteBackup', {
      data,
      context,
    }),
  )

export const deleteBackupsOlderThan = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.deleteBackupsOlderThan,
      'deleteBackupsOlderThan',
      { data, context },
    ),
  )

export const createBackup = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.createBackup, 'createBackup', {
      data,
      context,
    }),
  )

export const restoreBackup = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.restoreBackup, 'restoreBackup', {
      data,
      context,
    }),
  )
