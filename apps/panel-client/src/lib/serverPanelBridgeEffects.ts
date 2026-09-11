import { createServerFn } from '@tanstack/react-start'
import { permissionMiddleware, protectedServerFunctionMiddleware } from './serverAuth'

type AnyRecord = Record<string, any>

type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  params?: unknown
  status?: unknown
  data?: unknown
}

// eslint-disable-next-line no-control-regex
const BRIDGE_USERNAME_REGEX = /^(?=.*\S)[^\x00-\x1F\x7F"\\]{1,64}$/

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
  const details = error && typeof error === 'object' ? (error as ServiceError) : {}
  const status = typeof details.status === 'number' ? details.status : fallbackStatus
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

function capabilityMiddleware(capability: string) {
  return [
    ...protectedServerFunctionMiddleware,
    permissionMiddleware(capability),
  ] as const
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
    const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
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

function argsFor(data: AnyRecord): AnyRecord {
  if (
    data.args !== undefined &&
    (typeof data.args !== 'object' || data.args === null || Array.isArray(data.args))
  ) {
    invalid('args must be an object', 'PANELBRIDGE_ARGS_MUST_BE_OBJECT')
  }
  return record(data.args)
}

function requiredUsername(args: AnyRecord, code: string): string {
  if (
    typeof args.username !== 'string' ||
    !BRIDGE_USERNAME_REGEX.test(args.username)
  ) {
    invalid('Valid username is required', code)
  }
  return args.username
}

function optionalUsername(args: AnyRecord, code: string): string | undefined {
  const username = args.username
  if (
    username !== undefined &&
    username !== null &&
    username !== '' &&
    (typeof username !== 'string' || !BRIDGE_USERNAME_REGEX.test(username))
  ) {
    invalid('Invalid username format', code)
  }
  return username as string | undefined
}

async function executeEndangerAction(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
  const action = data.action
  if (typeof action !== 'string' || !action) {
    invalid('action is required', ErrorCode.PANELBRIDGE_ACTION_REQUIRED)
  }
  const args = argsFor(data)

  switch (action) {
    case 'playSoundNearPlayer': {
      const username = requiredUsername(
        args,
        ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
      )
      return withBridge(async (bridge) => {
        try {
          return await bridge.playSoundNearPlayer(username, args.radius, args.volume)
        } catch {
          throwBridgeError(
            Object.assign(new Error('Failed to play sound'), {
              code: ErrorCode.PANELBRIDGE_PLAY_SOUND_FAILED,
            }),
            500,
          )
        }
      })
    }
    case 'triggerGunshot': {
      const username = optionalUsername(
        args,
        ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
      )
      return withBridge(async (bridge) => {
        try {
          return await bridge.triggerGunshot({
            x: args.x,
            y: args.y,
            z: args.z,
            username,
          })
        } catch {
          throwBridgeError(
            Object.assign(new Error('Failed to trigger gunshot'), {
              code: ErrorCode.PANELBRIDGE_TRIGGER_GUNSHOT_FAILED,
            }),
            500,
          )
        }
      })
    }
    case 'triggerAlarmSound': {
      const username = optionalUsername(
        args,
        ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
      )
      return withBridge((bridge) =>
        bridge.triggerAlarmSound({
          x: args.x,
          y: args.y,
          z: args.z,
          username,
        }),
      )
    }
    case 'createNoise': {
      const username = optionalUsername(
        args,
        ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
      )
      return withBridge((bridge) =>
        bridge.createNoise({
          x: args.x,
          y: args.y,
          z: args.z,
          radius: args.radius,
          volume: args.volume,
          username,
        }),
      )
    }
    case 'spawnHordeNearPlayer':
    case 'spawnHordeBehindPlayer': {
      const username = requiredUsername(
        args,
        ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
      )
      const count = Math.min(Math.max(Math.floor(Number(args.count) || 50), 1), 500)
      return withBridge(
        (bridge) =>
          bridge.sendCommand(action, {
            username,
            count,
          }),
        ErrorCode.BRIDGE_NOT_RUNNING_BARE,
      )
    }
    default:
      invalid('Unknown or invalid action', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }
}

async function executeCatalogRead(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
  const kind = data.kind
  if (kind !== 'items' && kind !== 'vehicles') {
    invalid('Unknown or invalid catalog', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }

  try {
    const { getDb } = await import('../../../panel-server/database/init.ts')
    const db = await getDb()
    const catalog = db.data[kind === 'items' ? 'itemCatalog' : 'vehicleCatalog'] || null
    return (
      catalog ??
      (kind === 'items'
        ? { items: [], count: 0, scannedAt: null }
        : { vehicles: [], count: 0, scannedAt: null })
    )
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
  const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
  const kind = data.kind
  if (kind !== 'items' && kind !== 'vehicles') {
    invalid('Unknown or invalid catalog', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }

  try {
    const action = kind === 'items' ? 'getItemCatalog' : 'getVehicleCatalog'
    const result = (await withBridge(
      (bridge) => bridge.sendCommand(action, {}),
      kind === 'items'
        ? ErrorCode.PANELBRIDGE_SCAN_ITEMS_NOT_RUNNING
        : ErrorCode.PANELBRIDGE_SCAN_VEHICLES_NOT_RUNNING,
    )) as AnyRecord

    if (!result?.success) {
      throwBridgeError(
        new Error(
          result?.error ||
            (kind === 'items' ? 'Item scan failed' : 'Vehicle scan failed'),
        ),
        500,
      )
    }

    const catalog =
      kind === 'items'
        ? {
            items: result.data?.items || [],
            count: result.data?.count || 0,
            scannedAt: new Date().toISOString(),
          }
        : {
            vehicles: result.data?.vehicles || [],
            count: result.data?.count || 0,
            scannedAt: new Date().toISOString(),
          }

    const { getDb, commitNow } =
      await import('../../../panel-server/database/init.ts')
    const db = await getDb()
    db.data[kind === 'items' ? 'itemCatalog' : 'vehicleCatalog'] = catalog
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

export const sendPanelBridgeEndangerCommand = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.endanger_or_impersonate'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeEndangerAction(data)) as any)

export const getPanelBridgeCatalog = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeCatalogRead(data)) as any)

export const scanPanelBridgeCatalog = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('bridge.diagnostics'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeCatalogScan(data)) as any)

;(sendPanelBridgeEndangerCommand as any).__executeImplementation = (
  data: unknown,
) => executeEndangerAction(record(data))
;(getPanelBridgeCatalog as any).__executeImplementation = (data: unknown) =>
  executeCatalogRead(record(data))
;(scanPanelBridgeCatalog as any).__executeImplementation = (data: unknown) =>
  executeCatalogScan(record(data))
