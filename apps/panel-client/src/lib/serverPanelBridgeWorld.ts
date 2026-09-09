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

function throwWorldError(error: unknown, fallbackStatus = 500): never {
  const details = error && typeof error === 'object' ? (error as ServiceError) : {}
  const status = typeof details.status === 'number' ? details.status : fallbackStatus
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
  requirePath: boolean,
  operation: (bridge: AnyRecord) => Promise<T>,
): Promise<T> {
  try {
    const bridge = await panelBridge()
    const { ErrorCode } = await import('../../../panel-server/utils/errorCodes.ts')

    if (requirePath && !bridge.bridgePath) {
      invalid('Bridge not configured', ErrorCode.BRIDGE_NOT_CONFIGURED)
    }
    if (!bridge.isRunning) {
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
    throwWorldError(
      Object.assign(new Error(sanitizeError(errorMessage(error))), { status: 500 }),
    )
  }
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  )
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && isNumberInRange(value, min, max)
}

async function executeWorldAction(data: AnyRecord): Promise<unknown> {
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
    case 'getWeather':
      return withBridge(true, (bridge) => bridge.getWeather())
    case 'getClimateFloats':
      return withBridge(false, (bridge) => bridge.getClimateFloats())
    case 'getGameTime':
      return withBridge(false, (bridge) => bridge.getGameTime())
    case 'getWorldStats':
      return withBridge(false, (bridge) => bridge.getWorldStats())
    case 'getZombieCount':
      return withBridge(false, (bridge) => bridge.sendCommand('getZombieCount', {}))
    case 'triggerBlizzard':
      return withBridge(false, (bridge) => bridge.triggerBlizzard(args.duration))
    case 'triggerTropicalStorm':
      return withBridge(false, (bridge) => bridge.triggerTropicalStorm(args.duration))
    case 'triggerStorm':
      if (
        args.duration !== undefined &&
        !isNumberInRange(args.duration, 0, 168)
      ) {
        invalid(
          'duration must be a number 0-168 (hours)',
          ErrorCode.PANELBRIDGE_STORM_DURATION_INVALID,
        )
      }
      return withBridge(false, (bridge) => bridge.triggerStorm(args.duration))
    case 'stopWeather':
      return withBridge(false, (bridge) => bridge.stopWeather())
    case 'setSnow':
      if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
        invalid('enabled must be a boolean')
      }
      if (
        args.intensity !== undefined &&
        args.intensity !== null &&
        !isNumberInRange(args.intensity, 0, 1)
      ) {
        invalid(
          'intensity must be a number 0-1',
          ErrorCode.BRIDGE_INTENSITY_MUST_BE_NUMBER_0_1,
        )
      }
      return withBridge(false, (bridge) =>
        bridge.setSnow(args.enabled !== false, args.intensity ?? null),
      )
    case 'generateWeather':
      if (
        args.strength !== undefined &&
        !isNumberInRange(args.strength, 0, 1)
      ) {
        invalid(
          'strength must be a number 0-1',
          ErrorCode.PANELBRIDGE_WEATHER_STRENGTH_INVALID,
        )
      }
      if (
        args.frontType !== undefined &&
        !isIntegerInRange(args.frontType, 0, 5)
      ) {
        invalid(
          'frontType must be an integer 0-5',
          ErrorCode.PANELBRIDGE_WEATHER_FRONT_TYPE_INVALID,
        )
      }
      return withBridge(false, (bridge) =>
        bridge.generateWeather(args.strength ?? 0.5, args.frontType ?? 0),
      )
    case 'startRain':
      if (
        args.intensity !== undefined &&
        !isNumberInRange(args.intensity, 0, 1)
      ) {
        invalid(
          'intensity must be a number 0-1',
          ErrorCode.BRIDGE_INTENSITY_MUST_BE_NUMBER_0_1,
        )
      }
      return withBridge(false, (bridge) => bridge.startRain(args.intensity ?? 0.5))
    case 'stopRain':
      return withBridge(false, (bridge) => bridge.stopRain())
    case 'triggerLightning':
      if (args.x !== undefined && !isNumberInRange(args.x, -Infinity, Infinity)) {
        invalid('x must be a number', ErrorCode.PANELBRIDGE_LIGHTNING_X_INVALID)
      }
      if (args.y !== undefined && !isNumberInRange(args.y, -Infinity, Infinity)) {
        invalid('y must be a number', ErrorCode.PANELBRIDGE_LIGHTNING_Y_INVALID)
      }
      return withBridge(false, (bridge) =>
        bridge.triggerLightning(args.x, args.y, args.strike, args.light, args.rumble),
      )
    case 'setClimateFloat':
      if (args.floatId === undefined || args.value === undefined) {
        invalid(
          'floatId and value are required',
          ErrorCode.PANELBRIDGE_CLIMATE_FLOAT_FIELDS_REQUIRED,
        )
      }
      if (!isIntegerInRange(args.floatId, 0, 12)) {
        invalid(
          'floatId must be an integer 0-12',
          ErrorCode.PANELBRIDGE_CLIMATE_FLOAT_ID_INVALID,
        )
      }
      if (typeof args.value !== 'number' || !Number.isFinite(args.value)) {
        invalid(
          'value must be a number',
          ErrorCode.PANELBRIDGE_CLIMATE_FLOAT_VALUE_INVALID,
        )
      }
      return withBridge(false, (bridge) =>
        bridge.setClimateFloat(args.floatId, args.value, args.enable !== false),
      )
    case 'resetClimateOverrides':
      return withBridge(false, (bridge) => bridge.resetClimateOverrides())
    case 'setGameTime':
      if (
        args.hour !== undefined &&
        !isIntegerInRange(args.hour, 0, 23)
      ) {
        invalid(
          'hour must be an integer 0-23',
          ErrorCode.PANELBRIDGE_GAMETIME_HOUR_INVALID,
        )
      }
      if (args.day !== undefined && !isIntegerInRange(args.day, 1, 31)) {
        invalid(
          'day must be an integer 1-31',
          ErrorCode.PANELBRIDGE_GAMETIME_DAY_INVALID,
        )
      }
      if (args.month !== undefined && !isIntegerInRange(args.month, 1, 12)) {
        invalid(
          'month must be an integer 1-12',
          ErrorCode.PANELBRIDGE_GAMETIME_MONTH_INVALID,
        )
      }
      if (args.year !== undefined && !isIntegerInRange(args.year, 1, 9999)) {
        invalid(
          'year must be an integer 1-9999',
          ErrorCode.PANELBRIDGE_GAMETIME_YEAR_INVALID,
        )
      }
      return withBridge(false, (bridge) =>
        bridge.setGameTime({
          hour: args.hour,
          day: args.day,
          month: args.month,
          year: args.year,
        }),
      )
    default:
      invalid('Unknown or invalid action', ErrorCode.PANELBRIDGE_UNKNOWN_ACTION)
  }
}

export const sendPanelBridgeWorldCommand = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => (await executeWorldAction(data)) as any)

export const getPanelBridgeServerInfo = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(async () =>
    withBridge(true, async (bridge) => {
      const result = await bridge.getServerInfo()
      const players = result?.data?.players
      if (players && !Array.isArray(players)) {
        return {
          ...result,
          data: { ...result.data, players: Object.values(players) },
        }
      }
      return result
    }),
  )

export const savePanelBridgeWorld = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.control'))
  .validator((data: unknown) => record(data))
  .handler(async () => (await withBridge(false, (bridge) => bridge.saveWorld())) as any)
