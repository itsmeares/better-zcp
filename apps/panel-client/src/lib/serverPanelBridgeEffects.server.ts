import { createServerFn } from '@tanstack/react-start'
import { protectedServerFunctionMiddleware } from './serverAuth.server'

type AnyRecord = Record<string, any>

type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  params?: unknown
  status?: unknown
  data?: unknown
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

function throwBridgeError(error: unknown, fallbackStatus = 500): never {
  const details =
    error && typeof error === 'object' ? (error as ServiceError) : {}
  const status =
    typeof details.status === 'number' ? details.status : fallbackStatus
  throw Object.assign(new Error(errorMessage(error)), {
    status,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(details.params !== undefined ? { params: details.params } : {}),
    ...(details.data !== undefined ? { data: details.data } : {}),
  })
}

function invalid(message: string, code?: string, params?: unknown): never {
  throwBridgeError(
    Object.assign(new Error(message), {
      ...(code ? { code } : {}),
      ...(params !== undefined ? { params } : {}),
    }),
    400,
  )
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

async function withBridge<T>(
  operation: (bridge: AnyRecord) => Promise<T>,
  notRunningCode?: string,
): Promise<T> {
  try {
    const runtime = await panelRuntime()
    const bridge = runtime.panelBridge as AnyRecord
    const { ErrorCode } =
      await import('../../../panel-server/utils/errorCodes.ts')
    if (!bridge.isRunning) {
      invalid(
        'Bridge not running. Start it first.',
        notRunningCode ?? ErrorCode.BRIDGE_NOT_RUNNING,
      )
    }
    return await operation(bridge)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as { status?: unknown }).status === 'number'
    ) {
      throw error
    }
    const { sanitizeError } =
      await import('../../../panel-server/utils/sanitize.ts')
    throwBridgeError(
      Object.assign(new Error(sanitizeError(errorMessage(error))), {
        status: 500,
        ...(typeof (error as ServiceError)?.code === 'string'
          ? { code: (error as ServiceError).code }
          : {}),
        ...(typeof (error as ServiceError)?.data === 'object'
          ? { data: (error as ServiceError).data }
          : {}),
      }),
      500,
    )
  }
}

async function executeCatalogRead(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } =
    await import('../../../panel-server/utils/errorCodes.ts')
  const kind = data.kind
  if (kind !== 'items') {
    invalid('Unknown or invalid catalog', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }

  try {
    const { getDb } = await import('../../../panel-server/database/init.ts')
    const db = await getDb()
    return db.data.itemCatalog ?? { items: [], count: 0, scannedAt: null }
  } catch (error) {
    const { sanitizeError } =
      await import('../../../panel-server/utils/sanitize.ts')
    throwBridgeError(
      Object.assign(new Error(sanitizeError(errorMessage(error))), {
        status: 500,
      }),
    )
  }
}

async function executeCatalogScan(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } =
    await import('../../../panel-server/utils/errorCodes.ts')
  const kind = data.kind
  if (kind !== 'items') {
    invalid('Unknown or invalid catalog', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }

  try {
    const result = (await withBridge(
      (bridge) => bridge.sendCommand('getItemCatalog', {}),
      ErrorCode.PANELBRIDGE_SCAN_ITEMS_NOT_RUNNING,
    )) as AnyRecord

    if (!result?.success) {
      throwBridgeError(
        new Error(
          result?.error || 'Item scan failed',
        ),
        500,
      )
    }

    const catalog = {
      items: result.data?.items || [],
      count: result.data?.count || 0,
      scannedAt: new Date().toISOString(),
    }

    const { getDb, commitNow } =
      await import('../../../panel-server/database/init.ts')
    const db = await getDb()
    db.data.itemCatalog = catalog
    await commitNow()
    return catalog
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as { status?: unknown }).status === 'number'
    ) {
      throw error
    }
    const { sanitizeError } =
      await import('../../../panel-server/utils/sanitize.ts')
    throwBridgeError(
      Object.assign(new Error(sanitizeError(errorMessage(error))), {
        status: 500,
      }),
    )
  }
}

export const getPanelBridgeCatalog = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeCatalogRead(data)) as any)

export const scanPanelBridgeCatalog = createServerFn({ method: 'POST' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeCatalogScan(data)) as any)

;(getPanelBridgeCatalog as any).__executeImplementation = (data: unknown) =>
  executeCatalogRead(record(data))
;(scanPanelBridgeCatalog as any).__executeImplementation = (data: unknown) =>
  executeCatalogScan(record(data))
