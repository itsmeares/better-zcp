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
): Promise<T> {
  try {
    const bridge = (await panelRuntime()).panelBridge as AnyRecord
    if (!bridge.isRunning) {
      const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
      invalid('Bridge not running. Start it first.', ErrorCode.BRIDGE_NOT_RUNNING)
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
    (typeof data.args !== 'object' || data.args === null || Array.isArray(data.args))
  ) {
    invalid('args must be an object', 'PANELBRIDGE_ARGS_MUST_BE_OBJECT')
  }
  return record(data.args)
}

async function executePlayerAction(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
  const action = data.action
  if (typeof action !== 'string' || !action) {
    invalid('action is required', ErrorCode.PANELBRIDGE_ACTION_REQUIRED)
  }
  const args = validateArgs(data)

  function username(): string {
    if (typeof args.username !== 'string' || !BRIDGE_USERNAME_REGEX.test(args.username)) {
      invalid('Invalid username format', ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT)
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
        (z !== undefined &&
          (typeof z !== 'number' || !Number.isFinite(z)))
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
      return withBridge((bridge) =>
        bridge.sendCommand('killPlayer', { username: player }),
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
    invalid(
      'message is required (max 2000 chars)',
      'BRIDGE_MESSAGE_REQUIRED',
    )
  }
  return data.message
}

async function trySendViaRcon(
  runtime: AnyRecord,
  message: string,
): Promise<AnyRecord | null> {
  const rconService = runtime.rconService as AnyRecord | undefined
  if (!rconService || !rconService.connected) return null
  const result = await rconService.serverMessage(message, { skipLog: true })
  return result?.success ? result : null
}

async function trySendViaRconSafely(
  runtime: AnyRecord,
  message: string,
): Promise<AnyRecord | null> {
  try {
    return await trySendViaRcon(runtime, message)
  } catch {
    return null
  }
}

async function executeAdminChat(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
  const message = requiredMessage(data)
  const runtime = await panelRuntime()
  const bridge = runtime.panelBridge as AnyRecord

  try {
    if (bridge.isRunning) {
      const result = await bridge.sendCommand('sendToAdminChat', { message })
      if (result?.success && result?.data?.method !== 'player:Say') return result
    }
    const rconResult = await trySendViaRcon(runtime, `[ADMIN] ${message}`)
    if (rconResult) {
      return {
        success: true,
        data: {
          message: 'Admin message sent via RCON (visible to all)',
          method: 'RCON',
        },
      }
    }
  } catch {
    const rconResult = await trySendViaRconSafely(runtime, `[ADMIN] ${message}`)
    if (rconResult) {
      return {
        success: true,
        data: {
          message: 'Admin message sent via RCON (visible to all)',
          method: 'RCON',
        },
      }
    }
    throwBridgeError(
      Object.assign(new Error('Failed to send admin message'), {
        code: ErrorCode.PANELBRIDGE_SEND_ADMIN_MESSAGE_FAILED,
      }),
      500,
    )
  }

  throwBridgeError(
    Object.assign(
      new Error('Neither PanelBridge nor RCON available for admin chat'),
      { code: ErrorCode.PANELBRIDGE_ADMIN_CHAT_UNAVAILABLE },
    ),
    400,
  )
}

async function executeGeneralChat(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
  const message = requiredMessage(data)
  const author =
    typeof data.author === 'string'
      ? data.author.trim().slice(0, 64) || 'Server'
      : 'Server'
  const runtime = await panelRuntime()
  const bridge = runtime.panelBridge as AnyRecord

  try {
    if (bridge.isRunning) {
      const result = await bridge.sendCommand('sendToGeneralChat', {
        message,
        author,
      })
      if (result?.success && result?.data?.method !== 'player:Say') return result
    }
    const rconResult = await trySendViaRcon(runtime, `[${author}] ${message}`)
    if (rconResult) {
      return {
        success: true,
        data: { message: 'Message sent via RCON', author, method: 'RCON' },
      }
    }
  } catch (error) {
    const rconResult = await trySendViaRconSafely(
      runtime,
      `[${author}] ${message}`,
    )
    if (rconResult) {
      return {
        success: true,
        data: { message: 'Message sent via RCON', author, method: 'RCON' },
      }
    }
    const { sanitizeError } =
      await import('../../../panel-server/utils/sanitize.ts')
    throwBridgeError(
      Object.assign(new Error(sanitizeError(errorMessage(error))), {
        status: 500,
      }),
    )
  }

  throwBridgeError(
    Object.assign(new Error('Neither PanelBridge nor RCON available for chat'), {
      code: ErrorCode.PANELBRIDGE_CHAT_UNAVAILABLE,
    }),
    400,
  )
}

async function executeChatAlert(data: AnyRecord): Promise<unknown> {
  const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')
  const message = requiredMessage(data)
  const alert = data.alert === undefined ? true : data.alert

  try {
    const runtime = await panelRuntime()
    const bridge = runtime.panelBridge as AnyRecord
    if (alert && bridge.isRunning) {
      const result = await bridge.sendCommand('sendToServerChat', {
        message,
        alert: true,
      })
      if (result?.success && result?.data?.method !== 'player:Say') return result
    }

    const rconResult = await trySendViaRcon(runtime, message)
    if (rconResult) {
      return {
        success: true,
        data: {
          message: alert
            ? 'Alert requested but RCON has no alert styling -- sent as a plain broadcast'
            : 'Alert sent via RCON',
          isAlert: false,
          method: 'RCON',
        },
      }
    }
    if (bridge.isRunning) {
      return await bridge.sendCommand('sendToServerChat', {
        message,
        alert,
      })
    }
  } catch (error) {
    const { sanitizeError } =
      await import('../../../panel-server/utils/sanitize.ts')
    throwBridgeError(
      Object.assign(new Error(sanitizeError(errorMessage(error))), {
        status: 500,
      }),
    )
  }

  throwBridgeError(
    Object.assign(new Error('Neither RCON nor PanelBridge available'), {
      code: ErrorCode.PANELBRIDGE_RCON_AND_BRIDGE_UNAVAILABLE,
    }),
    400,
  )
}

export const sendPanelBridgePlayerCommand = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executePlayerAction(data)) as any)

export const sendPanelBridgeServerMessage = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => {
    const message = requiredMessage(data)
    return (await withBridge((bridge) =>
      bridge.sendCommand('sendToServerChat', { message, isAlert: true }),
    )) as any
  })

export const getPanelBridgeChatInfo = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(async () =>
    (await withBridge((bridge) => bridge.sendCommand('getChatInfo', {}))) as any,
  )

export const sendPanelBridgeAdminChat = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.endanger_or_impersonate'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeAdminChat(data)) as any)

export const sendPanelBridgeGeneralChat = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.endanger_or_impersonate'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeGeneralChat(data)) as any)

export const sendPanelBridgeChatAlert = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeChatAlert(data)) as any)
