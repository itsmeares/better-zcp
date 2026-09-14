import { createServerFn, createServerOnlyFn } from '@tanstack/react-start'
import {
  deleteCookie,
  getRequest,
  setResponseStatus,
} from '@tanstack/react-start/server'
import {
  adminRoleMiddleware,
  diagnosticsMiddleware,
  panelSettingsMiddleware,
  permissionMiddleware,
  protectedServerFunctionMiddleware,
  type AuthContextUser,
} from './serverAuth.server'

type ServiceError = {
  message?: unknown
  code?: unknown
  params?: unknown
  missing?: unknown
  status?: unknown
}

type PerformanceHistoryEntry = {
  timestamp: string
  playerCount: number
  memoryUsed: number
  pzMemUsed?: number
  cpuUsage?: number
  hostMemUsed?: number
  hostMemTotal?: number
}

type AppRconTestResult = {
  success: boolean
  connected: boolean
  message?: string
  warning?: boolean
  error?: string
  detail?: string
  code?: string
}

type AppSettings = Record<string, any>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const throwServerError: (error: unknown, fallbackStatus: number) => never = createServerOnlyFn(
  (error: unknown, fallbackStatus: number): never => {
    const details =
      error && typeof error === 'object' ? (error as ServiceError) : {}
    const status =
      typeof details.status === 'number' ? details.status : fallbackStatus
    const safeError = Object.assign(new Error(errorMessage(error)), {
      status,
      ...(typeof details.code === 'string' ? { code: details.code } : {}),
      ...(details.params !== undefined ? { params: details.params } : {}),
      ...(details.missing !== undefined ? { missing: details.missing } : {}),
    })
    setResponseStatus(status)
    throw safeError
  },
)

function currentUser(context: unknown): AuthContextUser {
  return (context as { authenticatedUser: AuthContextUser }).authenticatedUser
}

const clearRefreshCookie = createServerOnlyFn(async () => {
  const request = getRequest()
  const { getRefreshCookieOptions } =
    await import('../../../panel-server/utils/refreshCookie.ts')
  deleteCookie(
    'refreshToken',
    getRefreshCookieOptions(
      {
        secure: request.url.startsWith('https:'),
        headers: {
          'x-forwarded-proto':
            request.headers.get('x-forwarded-proto') ?? undefined,
        },
      },
      false,
    ),
  )
})

async function getAppSettingsImplementation() {
  const { getAllSettings } =
    await import('../../../panel-server/database/init.ts')
  const { maskSensitiveObject } =
    await import('../../../panel-server/utils/sanitize.ts')
  return {
    settings: maskSensitiveObject(await getAllSettings()) as AppSettings,
  }
}

export const getAppSettings = createServerFn({ method: 'GET' }).handler(
  getAppSettingsImplementation,
)
;(getAppSettings as any).__executeImplementation = getAppSettingsImplementation

const serverConfigureMiddleware = [
  ...protectedServerFunctionMiddleware,
  permissionMiddleware('server.configure'),
] as const

async function getPanelRuntime() {
  const { getPanelRuntime: readPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return readPanelRuntime()
}

async function updateAppSettingsImplementation(
  data: { settings?: unknown },
  context: unknown,
) {
  try {
    const { saveAppSettings } =
      await import('../../../panel-server/services/appSettings.ts')
    return await saveAppSettings(data.settings, {
      userRole: currentUser(context).role,
      runtime: await getPanelRuntime(),
    })
  } catch (error) {
    throwServerError(error, 500)
  }
}

export const updateAppSettings = createServerFn({ method: 'POST' })
  .middleware(panelSettingsMiddleware)
  .validator((data: { settings?: unknown } | undefined) => data ?? {})
  .handler(({ data, context }) =>
    updateAppSettingsImplementation(data, context),
  )
;(updateAppSettings as any).__executeImplementation = updateAppSettingsImplementation

async function getCorsDiagnosticsImplementation() {
  const runtime = await getPanelRuntime()
  if (typeof runtime.getCorsDebugSnapshot !== 'function') {
    throwServerError(
      Object.assign(new Error('CORS diagnostics are not available'), {
        code: 'CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE',
      }),
      500,
    )
  }
  return { diagnostics: runtime.getCorsDebugSnapshot() }
}

export const getCorsDiagnostics = createServerFn({ method: 'GET' })
  .middleware(diagnosticsMiddleware)
  .handler(getCorsDiagnosticsImplementation)
;(getCorsDiagnostics as any).__executeImplementation = getCorsDiagnosticsImplementation

async function reloadCorsDiagnosticsImplementation() {
  const runtime = await getPanelRuntime()
  if (typeof runtime.refreshCorsConfig !== 'function') {
    throwServerError(
      Object.assign(new Error('CORS config reload is not available'), {
        code: 'CONFIG_CORS_RELOAD_UNAVAILABLE',
      }),
      500,
    )
  }
  return {
    success: true,
    diagnostics: await runtime.refreshCorsConfig(),
  }
}

export const reloadCorsDiagnostics = createServerFn({ method: 'POST' })
  .middleware(diagnosticsMiddleware)
  .handler(reloadCorsDiagnosticsImplementation)
;(reloadCorsDiagnostics as any).__executeImplementation = reloadCorsDiagnosticsImplementation

async function clearCorsBlockedOriginsImplementation() {
  const runtime = await getPanelRuntime()
  if (
    typeof runtime.clearCorsBlockedOrigins !== 'function' ||
    typeof runtime.getCorsDebugSnapshot !== 'function'
  ) {
    throwServerError(
      Object.assign(new Error('CORS diagnostics are not available'), {
        code: 'CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE',
      }),
      500,
    )
  }
  runtime.clearCorsBlockedOrigins()
  return {
    success: true,
    diagnostics: runtime.getCorsDebugSnapshot(),
  }
}

export const clearCorsBlockedOrigins = createServerFn({ method: 'POST' })
  .middleware(diagnosticsMiddleware)
  .handler(clearCorsBlockedOriginsImplementation)
;(clearCorsBlockedOrigins as any).__executeImplementation = clearCorsBlockedOriginsImplementation

async function testAppRconConnectionImplementation(): Promise<AppRconTestResult> {
  const runtime = await getPanelRuntime()
  const rconService = runtime.rconService
  if (!rconService) {
    throwServerError(new Error('RCON service is not available'), 500)
  }

  try {
    const connected = await rconService.connect()
    if (connected) {
      try {
        const probe = await rconService.execute('players', { skipLog: true })
        if (!probe?.success) {
          const { sanitizeError } =
            await import('../../../panel-server/utils/sanitize.ts')
          return {
            success: true,
            message: 'Connected but command failed: ' + sanitizeError(probe?.error),
            connected: true,
            warning: true,
          }
        }
        return {
          success: true,
          message: 'RCON connection successful',
          connected: true,
        }
      } catch (commandError: unknown) {
        const { sanitizeError } =
          await import('../../../panel-server/utils/sanitize.ts')
        return {
          success: true,
          message: 'Connected but command failed: ' + sanitizeError(commandError),
          connected: true,
          warning: true,
        }
      }
    }

    const { host, port } = rconService.getConfig()
    const {
      checkTcpReachable,
      RCON_UNREACHABLE_DETAIL,
      RCON_AUTH_FAILED_DETAIL,
      RCON_USER_ACTION_TIMEOUT_MS,
    } = await import('../../../panel-server/services/rcon.ts')
    if (!(await checkTcpReachable(host, port, RCON_USER_ACTION_TIMEOUT_MS))) {
      return {
        success: false,
        error: 'unreachable' as const,
        detail: RCON_UNREACHABLE_DETAIL,
        message: RCON_UNREACHABLE_DETAIL,
        connected: false,
        code: 'RCON_CONNECT_UNREACHABLE',
      }
    }
    return {
      success: false,
      error: 'auth_failed' as const,
      detail: RCON_AUTH_FAILED_DETAIL,
      message: RCON_AUTH_FAILED_DETAIL,
      connected: false,
      code: 'RCON_CONNECT_AUTH_FAILED',
    }
  } catch (error: unknown) {
    const { sanitizeError } =
      await import('../../../panel-server/utils/sanitize.ts')
    return {
      success: false,
      error: sanitizeError(error),
      connected: false,
    }
  }
}

export const testAppRconConnection = createServerFn({ method: 'POST' })
  .middleware(serverConfigureMiddleware)
  .handler(testAppRconConnectionImplementation)
;(testAppRconConnection as any).__executeImplementation = testAppRconConnectionImplementation

async function getDebugRamImplementation() {
  const os = await import('node:os')
  const totalGB = Math.floor(os.totalmem() / (1024 * 1024 * 1024))
  const freeGB = Math.floor(os.freemem() / (1024 * 1024 * 1024))
  const availableForServer = Math.max(1, totalGB - 4)
  const recommendedMax = Math.min(Math.floor(availableForServer * 0.75), 16)
  return {
    totalGB,
    freeGB,
    recommendedMin: Math.max(1, Math.floor(recommendedMax * 0.5)),
    recommendedMax,
  }
}

export const getDebugRam = createServerFn({ method: 'GET' })
  .middleware(diagnosticsMiddleware)
  .handler(getDebugRamImplementation)
;(getDebugRam as any).__executeImplementation = getDebugRamImplementation

async function getPerformanceHistoryImplementation(
  data: { limit?: number },
): Promise<{ history: PerformanceHistoryEntry[] }> {
  try {
    const { getPerformanceHistory: readPerformanceHistory } =
      await import('../../../panel-server/database/init.ts')
    return {
      history: (await readPerformanceHistory(
        data.limit ?? 30,
      )) as PerformanceHistoryEntry[],
    }
  } catch (error) {
    throwServerError(error, 500)
  }
}

export const getPerformanceHistory = createServerFn({ method: 'GET' })
  .middleware(diagnosticsMiddleware)
  .validator((data: { limit?: number } | undefined) => data ?? {})
  .handler(({ data }) => getPerformanceHistoryImplementation(data))
;(getPerformanceHistory as any).__executeImplementation = getPerformanceHistoryImplementation

async function changePasswordImplementation(
  data: { currentPassword: string; newPassword: string },
  context: unknown,
) {
  try {
    const user = currentUser(context)
    if (!user.userId)
      throw Object.assign(new Error('Not authenticated'), { status: 401 })
    if (!data.currentPassword || !data.newPassword) {
      throw Object.assign(new Error('Current and new password are required'), {
        status: 400,
      })
    }
    if (data.newPassword.length > 128) {
      throw Object.assign(new Error('Password must be 128 characters or fewer'), {
        status: 400,
      })
    }
    const { default: authService } =
      await import('../../../panel-server/services/auth.ts')
    await authService.changePassword(
      user.userId,
      data.currentPassword,
      data.newPassword,
    )
    await clearRefreshCookie()
    return { success: true, message: 'Password changed successfully' }
  } catch (error) {
    throwServerError(error, 400)
  }
}

export const changePassword = createServerFn({ method: 'POST' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: { currentPassword: string; newPassword: string }) => data)
  .handler(({ data, context }) => changePasswordImplementation(data, context))
;(changePassword as any).__executeImplementation = changePasswordImplementation

async function regenerateJwtSecretImplementation() {
  try {
    const { default: authService } =
      await import('../../../panel-server/services/auth.ts')
    await authService.regenerateJwtSecret()
    await clearRefreshCookie()
    return {
      success: true,
      message:
        'JWT signing key regenerated. Every session has been invalidated, including this one — you will need to log in again.',
    }
  } catch (error) {
    throwServerError(error, 400)
  }
}

export const regenerateJwtSecret = createServerFn({ method: 'POST' })
  .middleware(adminRoleMiddleware)
  .handler(regenerateJwtSecretImplementation)
;(regenerateJwtSecret as any).__executeImplementation = regenerateJwtSecretImplementation
