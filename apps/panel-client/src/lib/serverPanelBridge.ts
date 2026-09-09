import { createServerFn } from '@tanstack/react-start'
import {
  type AuthContextUser,
  protectedServerFunctionMiddleware,
} from './serverAuth'
import {
  BRIDGE_ACTION_CAPABILITY,
  ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS,
  GM_TOOLS_ONLY_ACTIONS,
  ITEM_TYPE_REGEX,
  VALID_ACTIONS,
  VEHICLE_SCRIPT_REGEX,
} from '../../../panel-server/services/panelBridgePolicy.ts'

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

function getUser(context: unknown): AuthContextUser {
  const user = (context as { authenticatedUser?: AuthContextUser } | undefined)
    ?.authenticatedUser
  if (!user) invalid('Authentication required', 'AUTH_REQUIRED')
  return user
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

async function assertCommandPermissions(
  action: string,
  context: unknown,
  getRoleByName: (name: unknown) => Promise<AnyRecord | null>,
): Promise<void> {
  const user = getUser(context)
  const role = await getRoleByName(user.role)
  const capabilities = Array.isArray(role?.capabilities)
    ? role.capabilities
    : []
  const bridgeCommandExempt =
    GM_TOOLS_ONLY_ACTIONS.has(action) ||
    ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS.has(action)

  if (!bridgeCommandExempt && !capabilities.includes('bridge.command')) {
    throwBridgeError(
      Object.assign(new Error('Insufficient permissions'), {
        status: 403,
        code: 'PERMISSION_DENIED',
      }),
      403,
    )
  }

  const requiredCapability = BRIDGE_ACTION_CAPABILITY[action]
  if (requiredCapability && !capabilities.includes(requiredCapability)) {
    throwBridgeError(
      Object.assign(
        new Error(
          bridgeCommandExempt
            ? `"${action}" requires ${requiredCapability}.`
            : `"${action}" also requires ${requiredCapability}.`,
        ),
        { status: 403, code: 'PANELBRIDGE_ACTION_CAPABILITY_REQUIRED' },
      ),
      403,
    )
  }
}

const VALID_PRESETS = [
  'military',
  'medical',
  'food',
  'building',
  'weapons',
  'tools',
]

async function executePanelBridgeCommand(
  data: AnyRecord,
  context: unknown,
): Promise<any> {
  const [
    { getActiveServer, getRoleByName, logBridgeCommand },
    { ErrorCode },
    { sanitizeError, sanitizeErrorParams },
  ] = await Promise.all([
    import('../../../panel-server/database/init.ts'),
    import('../../../panel-server/utils/errorCodes.ts'),
    import('../../../panel-server/utils/sanitize.ts'),
  ])
  const runtime = await panelRuntime()
  const bridge = runtime.panelBridge
  const activeServer = await getActiveServer()

  if (activeServer?.isRemote && !bridge.isSftpRunning() && !bridge.isRunning) {
    invalid(
      'PanelBridge requires a configured mapped drive or a running SFTP bridge transport for remote servers.',
      ErrorCode.PANELBRIDGE_COMMAND_REMOTE_TRANSPORT_UNAVAILABLE,
    )
  }

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

  await assertCommandPermissions(action, context, getRoleByName)

  if (action === 'spawnVehicleAt') {
    const vehicle = args?.vehicle ?? args?.scriptName
    const x = Number(args?.x)
    const y = Number(args?.y)
    const z = Number(args?.z ?? 0)
    if (typeof vehicle !== 'string' || !VEHICLE_SCRIPT_REGEX.test(vehicle)) {
      invalid(
        'Invalid vehicle script name',
        ErrorCode.PANELBRIDGE_INVALID_VEHICLE_SCRIPT_NAME,
      )
    }
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      x < 0 ||
      x > 24000 ||
      y < 0 ||
      y > 24000 ||
      z < 0 ||
      z > 8 ||
      (x === 0 && y === 0)
    ) {
      invalid(
        'Invalid coordinates (x/y: 0-24000, z: 0-8)',
        ErrorCode.PANELBRIDGE_SPAWN_VEHICLE_INVALID_COORDS,
      )
    }

    try {
      const result = await runtime.rconService.addVehicleAt(vehicle, x, y, z)
      void logBridgeCommand(action, args, result, result.success, 0).catch(
        () => {},
      )
      return {
        ...result,
        data: result.success
          ? {
              message: 'Vehicle spawn requested',
              scriptName: vehicle,
              x: Math.floor(x),
              y: Math.floor(y),
              z: Math.floor(z),
            }
          : undefined,
      }
    } catch (error) {
      const message = sanitizeError(
        (error as AnyRecord)?.message || 'Vehicle spawn failed',
      )
      void logBridgeCommand(action, args, { error: message }, false, 0).catch(
        () => {},
      )
      return { success: false, error: message }
    }
  }

  if (!bridge.bridgePath) {
    invalid('Bridge not configured', ErrorCode.BRIDGE_NOT_CONFIGURED)
  }
  if (!bridge.isRunning) {
    invalid('Bridge not running. Start it first.', ErrorCode.BRIDGE_NOT_RUNNING)
  }

  if (action === 'airdrop' && args) {
    const x = Number(args.x)
    const y = Number(args.y)
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 24000 ||
      y < 0 ||
      y > 24000
    ) {
      invalid(
        'Invalid airdrop coordinates (valid: 0-24000)',
        ErrorCode.PANELBRIDGE_AIRDROP_INVALID_COORDS,
      )
    }
    if (
      args.preset &&
      (typeof args.preset !== 'string' || !VALID_PRESETS.includes(args.preset))
    ) {
      invalid(
        `Invalid preset. Valid: ${VALID_PRESETS.join(', ')}`,
        ErrorCode.PANELBRIDGE_AIRDROP_INVALID_PRESET,
        sanitizeErrorParams({ presets: VALID_PRESETS.join(', ') }),
      )
    }
    if (args.items && (!Array.isArray(args.items) || args.items.length > 50)) {
      invalid(
        'items must be an array with at most 50 entries',
        ErrorCode.PANELBRIDGE_AIRDROP_ITEMS_ARRAY_INVALID,
      )
    }
    if (Array.isArray(args.items)) {
      for (const entry of args.items) {
        if (!entry || typeof entry !== 'object') {
          invalid(
            'Each item must be an object with itemType',
            ErrorCode.PANELBRIDGE_AIRDROP_ITEM_INVALID,
          )
        }
        if (
          typeof entry.itemType !== 'string' ||
          !ITEM_TYPE_REGEX.test(entry.itemType)
        ) {
          const itemType = String(entry.itemType).slice(0, 60)
          invalid(
            `Invalid item type format: ${itemType}`,
            ErrorCode.PANELBRIDGE_AIRDROP_ITEM_TYPE_INVALID,
            sanitizeErrorParams({ itemType }),
          )
        }
        if (
          entry.count !== undefined &&
          (typeof entry.count !== 'number' ||
            entry.count < 1 ||
            entry.count > 20)
        ) {
          invalid(
            'Item count must be 1-20',
            ErrorCode.PANELBRIDGE_AIRDROP_ITEM_COUNT_INVALID,
          )
        }
      }
    }
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

export const sendPanelBridgeCommand = createServerFn({ method: 'POST' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(async ({ data, context }) => {
    try {
      return await executePanelBridgeCommand(data, context)
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
