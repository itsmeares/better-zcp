import { createServerFn } from '@tanstack/react-start'
import { protectedServerFunctionMiddleware } from './serverAuth.server'

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

function throwWorldError(error: unknown, fallbackStatus = 500): never {
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

function invalid(message: string, code?: string, params?: unknown): never {
  throwWorldError(
    Object.assign(new Error(message), {
      ...(code ? { code } : {}),
      ...(params !== undefined ? { params } : {}),
    }),
    400,
  )
}

async function panelBridge(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime().panelBridge as AnyRecord
}

async function withBridge<T>(
  requirePath: boolean,
  operation: (bridge: AnyRecord) => Promise<T>,
  notRunningCode?: string,
): Promise<T> {
  try {
    const bridge = await panelBridge()
    const { ErrorCode } =
      await import('../../../panel-server/utils/errorCodes.ts')

    if (requirePath && !bridge.bridgePath) {
      invalid('Bridge not configured', ErrorCode.BRIDGE_NOT_CONFIGURED)
    }
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
    throwWorldError(
      Object.assign(new Error(sanitizeError(errorMessage(error))), {
        status: 500,
      }),
    )
  }
}

async function persistUtilities(
  power: boolean,
  water: boolean,
  on: boolean,
): Promise<AnyRecord> {
  const values: AnyRecord = {}
  if (power) {
    values.ElecShut = on ? 9 : 1
    values.ElecShutModifier = on ? 2147483647 : 0
  }
  if (water) {
    values.WaterShut = on ? 9 : 1
    values.WaterShutModifier = on ? 2147483647 : 0
  }

  try {
    const { persistSandboxValues } =
      await import('../../../panel-server/services/sandboxPersistence.ts')
    const { persisted, reason } = await persistSandboxValues(values)
    return { persisted, persistReason: reason }
  } catch (error) {
    const { sanitizeError } =
      await import('../../../panel-server/utils/sanitize.ts')
    return {
      persisted: false,
      persistReason: sanitizeError(errorMessage(error)),
    }
  }
}

async function executeWorldAction(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } =
    await import('../../../panel-server/utils/errorCodes.ts')
  const action = data.action
  if (typeof action !== 'string' || !action) {
    invalid('action is required', ErrorCode.PANELBRIDGE_ACTION_REQUIRED)
  }
  if (
    data.args !== undefined &&
    (typeof data.args !== 'object' ||
      data.args === null ||
      Array.isArray(data.args))
  ) {
    invalid('args must be an object', ErrorCode.PANELBRIDGE_ARGS_MUST_BE_OBJECT)
  }

  const args = record(data.args)
  switch (action) {
    case 'getWorldStats':
      return withBridge(false, (bridge) => bridge.getWorldStats())
    case 'getSandboxOptions':
      return withBridge(false, (bridge) => bridge.getSandboxOptions())
    case 'getUtilitiesStatus':
      return withBridge(false, (bridge) =>
        bridge.sendCommand('getUtilitiesStatus', {}),
      )
    case 'restoreUtilities':
    case 'shutOffUtilities': {
      const power = args.power !== false
      const water = args.water !== false
      const result = (await withBridge(false, (bridge) =>
        bridge.sendCommand(action, { power, water }),
      )) as AnyRecord
      return {
        ...result,
        ...(await persistUtilities(
          power,
          water,
          action === 'restoreUtilities',
        )),
      }
    }
    default:
      invalid('Unknown or invalid action', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }
}

export const sendPanelBridgeWorldCommand = createServerFn({ method: 'POST' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeWorldAction(data)) as any)

async function getServerInfoImplementation(): Promise<any> {
  return withBridge(true, async (bridge) => {
    const result = await bridge.getServerInfo()
    const players = result?.data?.players
    if (players && !Array.isArray(players)) {
      return {
        ...result,
        data: { ...result.data, players: Object.values(players) },
      }
    }
    return result
  })
}

export const getPanelBridgeServerInfo = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(getServerInfoImplementation)

export const savePanelBridgeWorld = createServerFn({ method: 'POST' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(
    async () =>
      (await withBridge(false, (bridge) => bridge.saveWorld())) as any,
  )

;(sendPanelBridgeWorldCommand as any).__executeImplementation = (
  data: unknown,
) => executeWorldAction(record(data))
;(getPanelBridgeServerInfo as any).__executeImplementation =
  getServerInfoImplementation
;(savePanelBridgeWorld as any).__executeImplementation = () =>
  withBridge(false, (bridge) => bridge.saveWorld())
