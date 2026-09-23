import { createServerFn } from '@tanstack/react-start'
import { protectedServerFunctionMiddleware } from './serverAuth.server'
import {
  VALID_ACTIONS,
} from '../../../panel-server/services/panelBridgePolicy.ts'
import {
  PANEL_BRIDGE_COMMANDS,
} from '../../../panel-server/services/panelBridgeCommands.ts'

type AnyRecord = Record<string, any>

type ServiceError = {
  message?: unknown
  error?: unknown
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

async function executePanelBridgeCommand(data: AnyRecord): Promise<any> {
  const [
    { logBridgeCommand },
    { ErrorCode },
    { sanitizeError },
  ] = await Promise.all([
    import('../../../panel-server/database/init.ts'),
    import('../../../panel-server/utils/errorCodes.ts'),
    import('../../../panel-server/utils/sanitize.ts'),
  ])
  const runtime = await panelRuntime()
  const bridge = runtime.panelBridge
  const { action, args } = data
  if (!action)
    invalid('action is required', ErrorCode.PANELBRIDGE_ACTION_REQUIRED)
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    invalid('Unknown or invalid action', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }
  if (
    args !== undefined &&
    (typeof args !== 'object' || args === null || Array.isArray(args))
  ) {
    invalid('args must be an object', ErrorCode.PANELBRIDGE_ARGS_MUST_BE_OBJECT)
  }

  if (!bridge.bridgePath) {
    invalid('Bridge not configured', ErrorCode.BRIDGE_NOT_CONFIGURED)
  }
  if (!bridge.isRunning) {
    invalid('Bridge not running. Start it first.', ErrorCode.BRIDGE_NOT_RUNNING)
  }

  const commandArgs = args || {}
  const startTime = Date.now()
  try {
    const result = await bridge.sendCommand(action, commandArgs)
    const durationMs = Date.now() - startTime
    void logBridgeCommand(action, commandArgs, result, true, durationMs).catch(
      () => {},
    )
    return result
  } catch (error) {
    const durationMs = Date.now() - startTime
    const message = sanitizeError(
      (error as AnyRecord)?.message || 'Bridge command failed',
    )
    void logBridgeCommand(
      action,
      commandArgs,
      { error: message },
      false,
      durationMs,
    ).catch(() => {})
    const diagnosticFields =
      (error as AnyRecord)?.data &&
      typeof (error as AnyRecord).data === 'object'
        ? (error as AnyRecord).data
        : {}
    const category = /timeout/i.test(message)
      ? 'timeout'
      : /not configured|not running|unhealthy|not responding|stale|missing/i.test(
            message,
          )
        ? 'bridge-unavailable'
        : /invalid|required/i.test(message)
          ? 'validation'
          : 'unknown'
    throwBridgeError(
      Object.assign(new Error(message), {
        status:
          category === 'timeout'
            ? 504
            : category === 'bridge-unavailable'
              ? 503
              : category === 'validation'
                ? 400
                : 500,
        data: { ...diagnosticFields, category },
      }),
    )
  }
}

async function getPanelBridgeCommandsImplementation(): Promise<AnyRecord> {
  return {
    commands: PANEL_BRIDGE_COMMANDS,
  }
}

export const sendPanelBridgeCommand = createServerFn({ method: 'POST' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => {
    try {
      return await executePanelBridgeCommand(data)
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
      throw Object.assign(new Error(sanitizeError(errorMessage(error))), {
        status: 500,
      })
    }
  })

export const getPanelBridgeCommands = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(getPanelBridgeCommandsImplementation)

;(sendPanelBridgeCommand as any).__executeImplementation =
  executePanelBridgeCommand
;(getPanelBridgeCommands as any).__executeImplementation =
  getPanelBridgeCommandsImplementation
