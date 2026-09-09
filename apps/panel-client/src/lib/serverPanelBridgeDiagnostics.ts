import { createServerFn } from '@tanstack/react-start'
import { permissionMiddleware, protectedServerFunctionMiddleware } from './serverAuth'

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

function throwDiagnosticsError(error: unknown, fallbackStatus = 500): never {
  const details = error && typeof error === 'object' ? (error as ServiceError) : {}
  const status = typeof details.status === 'number' ? details.status : fallbackStatus
  throw Object.assign(new Error(errorMessage(error)), {
    status,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(details.params !== undefined ? { params: details.params } : {}),
  })
}

function invalid(message: string, code?: string): never {
  throwDiagnosticsError(
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

async function panelBridge(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime().panelBridge as AnyRecord
}

async function withBridge<T>(
  operation: (bridge: AnyRecord) => Promise<T>,
): Promise<T> {
  try {
    const bridge = await panelBridge()
    const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
    if (!bridge.isRunning) {
      invalid('Bridge not running', ErrorCode.BRIDGE_NOT_RUNNING_BARE)
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
    throwDiagnosticsError(
      Object.assign(new Error(sanitizeError(errorMessage(error))), { status: 500 }),
    )
  }
}

async function executeDiagnosticsAction(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
  const action = data.action
  if (typeof action !== 'string' || !action) {
    invalid('action is required', ErrorCode.PANELBRIDGE_ACTION_REQUIRED)
  }
  if (
    data.args !== undefined &&
    (typeof data.args !== 'object' || data.args === null || Array.isArray(data.args))
  ) {
    invalid('args must be an object', ErrorCode.PANELBRIDGE_ARGS_MUST_BE_OBJECT)
  }

  const args = record(data.args)
  switch (action) {
    case 'getDebugLog': {
      const { parseClampedInteger } =
        await import('../../../panel-server/utils/queryNumbers.ts')
      const limit = parseClampedInteger(args.limit, 50, 1, 500)
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR']
      const minLevel =
        typeof args.level === 'string' && validLevels.includes(args.level)
          ? args.level
          : 'DEBUG'
      return withBridge((bridge) =>
        bridge.sendCommand('getDebugLog', { limit, minLevel }),
      )
    }
    case 'getStats':
      return withBridge((bridge) => bridge.sendCommand('getStats', {}))
    case 'setDebugMode':
      if (typeof args.enabled !== 'boolean') {
        invalid('enabled must be a boolean')
      }
      return withBridge((bridge) =>
        bridge.sendCommand('setDebugMode', { enabled: args.enabled === true }),
      )
    case 'checkAPI': {
      const object = args.object
      const method = args.method
      if (
        object !== undefined &&
        (typeof object !== 'string' || !/^[a-zA-Z0-9_.]{1,100}$/.test(object))
      ) {
        invalid('Invalid object name', ErrorCode.PANELBRIDGE_INVALID_OBJECT_NAME)
      }
      if (
        method !== undefined &&
        (typeof method !== 'string' || !/^[a-zA-Z0-9_.]{1,100}$/.test(method))
      ) {
        invalid('Invalid method name', ErrorCode.PANELBRIDGE_INVALID_METHOD_NAME)
      }
      return withBridge((bridge) => bridge.sendCommand('checkAPI', { object, method }))
    }
    case 'getAvailableHandlers':
      return withBridge((bridge) =>
        bridge.sendCommand('getAvailableHandlers', {}),
      )
    case 'clearErrors':
      return withBridge((bridge) => bridge.clearErrors())
    case 'debugItemScript':
      return withBridge((bridge) => bridge.sendCommand('debugItemScript', {}))
    default:
      invalid('Unknown or invalid action', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }
}

export const sendPanelBridgeDiagnosticsCommand = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('bridge.diagnostics'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeDiagnosticsAction(data)) as any)
