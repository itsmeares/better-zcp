import { createServerFn } from '@tanstack/react-start'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

type AnyRecord = Record<string, any>
type ExecuteOptions = { data?: unknown; context?: unknown }
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

function middleware(capability?: string) {
  return capability
    ? ([
        ...protectedServerFunctionMiddleware,
        permissionMiddleware(capability),
      ] as const)
    : protectedServerFunctionMiddleware
}

async function invoke(name: string, options: ExecuteOptions): Promise<any> {
  const implementation = await import('./serverResourceActions')
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

function createAction(name: string, capability?: string) {
  return createServerFn({ method: 'POST' })
    .middleware(middleware(capability))
    .validator((data: unknown) => record(data))
    .handler(({ data, context }) => invoke(name, { data, context }))
}

export const createTemplate = createAction('createTemplate', 'templates.manage')
export const importTemplate = createAction('importTemplate', 'templates.manage')
export const previewTemplate = createAction('previewTemplate')
export const deleteTemplate = createAction('deleteTemplate', 'templates.manage')
export const unhideTemplate = createAction('unhideTemplate', 'templates.manage')
export const updateBackupSettings = createAction(
  'updateBackupSettings',
  'backups.manage',
)
export const deleteBackup = createAction('deleteBackup', 'backups.manage')
export const deleteBackupsOlderThan = createAction(
  'deleteBackupsOlderThan',
  'backups.manage',
)
