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
    const bridge = (await panelRuntime()).panelBridge as AnyRecord
    if (!bridge.isRunning) {
      const { ErrorCode } =
        await import('../../../panel-server/utils/errorCodes.ts')
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

function validateArgs(data: AnyRecord): AnyRecord {
  if (
    data.args !== undefined &&
    (typeof data.args !== 'object' ||
      data.args === null ||
      Array.isArray(data.args))
  ) {
    invalid('args must be an object', 'PANELBRIDGE_ARGS_MUST_BE_OBJECT')
  }
  return record(data.args)
}

async function executePlayerAction(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } =
    await import('../../../panel-server/utils/errorCodes.ts')
  const action = data.action
  if (typeof action !== 'string' || !action) {
    invalid('action is required', ErrorCode.PANELBRIDGE_ACTION_REQUIRED)
  }
  const args = validateArgs(data)

  function username(): string {
    if (
      typeof args.username !== 'string' ||
      !BRIDGE_USERNAME_REGEX.test(args.username)
    ) {
      invalid(
        'Invalid username format',
        ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
      )
    }
    return args.username
  }

  switch (action) {
    case 'getAllPlayerDetails':
      return withBridge((bridge) => bridge.getAllPlayerDetails())
    case 'getPlayerDetails': {
      const player = username()
      return withBridge(async (bridge) => {
        try {
          return await bridge.getPlayerDetails(player)
        } catch {
          throwBridgeError(
            Object.assign(new Error('Failed to get player details'), {
              code: ErrorCode.PANELBRIDGE_GET_PLAYER_DETAILS_FAILED,
            }),
            500,
          )
        }
      })
    }
    case 'teleportPlayer': {
      const player = username()
      const { x, y, z } = args
      if (x === undefined || y === undefined) {
        invalid(
          'x and y coordinates are required',
          ErrorCode.BRIDGE_XY_COORDS_REQUIRED,
        )
      }
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        (z !== undefined && (typeof z !== 'number' || !Number.isFinite(z)))
      ) {
        invalid(
          'Coordinates must be numbers',
          ErrorCode.PANELBRIDGE_TELEPORT_COORDS_NOT_NUMBERS,
        )
      }
      if (x < 0 || x > 24000 || y < 0 || y > 24000) {
        invalid(
          'x/y coordinates out of range (0-24000)',
          ErrorCode.PANELBRIDGE_TELEPORT_XY_OUT_OF_RANGE,
        )
      }
      if (z !== undefined && (z < 0 || z > 8)) {
        invalid(
          'z coordinate out of range (0-8)',
          ErrorCode.PANELBRIDGE_TELEPORT_Z_OUT_OF_RANGE,
        )
      }
      return withBridge(async (bridge) => {
        try {
          return await bridge.teleportPlayer(player, x, y, z)
        } catch (error) {
          const details = error as ServiceError
          throwBridgeError(
            Object.assign(new Error('Teleport failed'), {
              code: ErrorCode.PANELBRIDGE_TELEPORT_FAILED,
              ...(details?.data !== undefined ? { data: details.data } : {}),
            }),
            500,
          )
        }
      })
    }
    case 'killPlayer': {
      const player = username()
      return withBridge(
        (bridge) => bridge.sendCommand('killPlayer', { username: player }),
        ErrorCode.BRIDGE_NOT_RUNNING_BARE,
      )
    }
    case 'healPlayer': {
      const player = username()
      return withBridge(
        (bridge) => bridge.sendCommand('healPlayer', { username: player }),
        ErrorCode.BRIDGE_NOT_RUNNING_BARE,
      )
    }
    case 'giveItem': {
      const player = username()
      const { itemType, count = 1 } = args
      if (
        typeof itemType !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*$/.test(itemType)
      ) {
        invalid('itemType must be in Module.ItemName format (e.g., "Base.Axe")')
      }
      if (
        typeof count !== 'number' ||
        !Number.isFinite(count) ||
        count < 1 ||
        count > 100
      ) {
        invalid(
          'count must be 1-100',
          ErrorCode.PANELBRIDGE_HORDE_COUNT_INVALID,
        )
      }
      return withBridge(
        (bridge) =>
          bridge.sendCommand('giveItem', { username: player, itemType, count }),
        ErrorCode.BRIDGE_NOT_RUNNING_BARE,
      )
    }
    case 'setGodMode':
    case 'setInvisible': {
      const player = username()
      if (typeof args.enabled !== 'boolean')
        invalid('enabled must be a boolean')
      return withBridge(
        (bridge) =>
          bridge.sendCommand(action, {
          username: player,
          enabled: args.enabled === true,
        }),
        ErrorCode.BRIDGE_NOT_RUNNING_BARE,
      )
    }
    default:
      invalid('Unknown or invalid action', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }
}

function requiredMessage(data: AnyRecord): string {
  if (
    typeof data.message !== 'string' ||
    !data.message ||
    data.message.length > 2000
  ) {
    invalid('message is required (max 2000 chars)', 'BRIDGE_MESSAGE_REQUIRED')
  }
  return data.message
}

async function sendServerMessageImplementation(
  data: AnyRecord,
): Promise<unknown> {
  const message = requiredMessage(data)
  return withBridge((bridge) =>
    bridge.sendCommand('sendToServerChat', { message, isAlert: true }),
  )
}

export const sendPanelBridgePlayerCommand = createServerFn({ method: 'POST' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executePlayerAction(data)) as any)

export const sendPanelBridgeServerMessage = createServerFn({ method: 'POST' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(
    async ({ data }) => (await sendServerMessageImplementation(data)) as any,
  )

;(sendPanelBridgePlayerCommand as any).__executeImplementation = (
  data: unknown,
) => executePlayerAction(record(data))
;(sendPanelBridgeServerMessage as any).__executeImplementation = (
  data: unknown,
) => sendServerMessageImplementation(record(data))
