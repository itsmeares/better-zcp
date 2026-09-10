import { createServerFn, createServerOnlyFn } from '@tanstack/react-start'
import {
  deleteCookie,
  getRequest,
  getRequestUrl,
  setResponseStatus,
} from '@tanstack/react-start/server'
import type {
  ManagedUserAccount,
  OidcDiscoveredMetadata,
  OidcSettingsUpdate,
  OidcSettingsWithEnv,
  RoleInfo,
} from './api'
import {
  adminRoleMiddleware,
  diagnosticsMiddleware,
  panelSettingsMiddleware,
  permissionMiddleware,
  protectedServerFunctionMiddleware,
  rolesManageMiddleware,
  usersManageMiddleware,
  type AuthContextUser,
} from './serverAuth'

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

const currentRequestUrl = createServerOnlyFn(() => getRequestUrl())

const MAX_SCOPE_LENGTH = 500
const MAX_PROVIDER_NAME_LENGTH = 100

function isMaskedSecret(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  return value.startsWith('••••••••') || /^[•*●○]+$/.test(value)
}

function looksLikeUrl(value: unknown, allowHttp: boolean): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (url.protocol === 'http:' && allowHttp)
  } catch {
    return false
  }
}

function publicOidcSettings(settings: {
  issuerUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scope: string
  providerName: string
  allowInsecureHttp: boolean
}) {
  return {
    issuerUrl: settings.issuerUrl,
    clientId: settings.clientId,
    clientSecretConfigured: Boolean(settings.clientSecret),
    redirectUri: settings.redirectUri,
    scope: settings.scope,
    providerName: settings.providerName,
    allowInsecureHttp: settings.allowInsecureHttp,
    configured: Boolean(
      settings.issuerUrl &&
      settings.clientId &&
      settings.clientSecret &&
      settings.redirectUri,
    ),
  }
}

function buildOidcUpdates(
  body: OidcSettingsUpdate,
  current: {
    allowInsecureHttp: boolean
  },
) {
  const updates: Record<string, unknown> = {}

  if (body.issuerUrl !== undefined) {
    const value = String(body.issuerUrl).trim()
    if (value) {
      const allowHttp =
        body.allowInsecureHttp !== undefined
          ? Boolean(body.allowInsecureHttp)
          : current.allowInsecureHttp
      if (!looksLikeUrl(value, allowHttp)) {
        throw Object.assign(
          new Error(
            allowHttp
              ? 'issuerUrl must be a valid URL'
              : 'issuerUrl must be a valid https:// URL (enable allowInsecureHttp to permit http://)',
          ),
          { status: 400 },
        )
      }
    }
    updates.issuerUrl = value
  }

  if (body.clientId !== undefined)
    updates.clientId = String(body.clientId).trim()

  if (body.clientSecret !== undefined) {
    if (!isMaskedSecret(body.clientSecret))
      updates.clientSecret = String(body.clientSecret)
  }

  if (body.redirectUri !== undefined) {
    const value = String(body.redirectUri).trim()
    if (value) {
      try {
        new URL(value)
      } catch {
        throw Object.assign(new Error('redirectUri must be a valid URL'), {
          status: 400,
        })
      }
    }
    updates.redirectUri = value
  }

  if (body.scope !== undefined) {
    const value = String(body.scope).trim()
    if (value.length > MAX_SCOPE_LENGTH) {
      throw Object.assign(
        new Error(`scope must be ${MAX_SCOPE_LENGTH} characters or fewer`),
        { status: 400 },
      )
    }
    updates.scope = value
  }

  if (body.providerName !== undefined) {
    const value = String(body.providerName).trim()
    if (value.length > MAX_PROVIDER_NAME_LENGTH) {
      throw Object.assign(
        new Error(
          `providerName must be ${MAX_PROVIDER_NAME_LENGTH} characters or fewer`,
        ),
        { status: 400 },
      )
    }
    updates.providerName = value
  }

  if (body.allowInsecureHttp !== undefined) {
    updates.allowInsecureHttp = Boolean(body.allowInsecureHttp)
  }

  return updates
}

async function getManagedUsersImplementation() {
  const { default: authService } =
    await import('../../../panel-server/services/auth.ts')
  return { users: (await authService.getUsers()) as ManagedUserAccount[] }
}

export const getManagedUsers = createServerFn({ method: 'GET' })
  .middleware(usersManageMiddleware)
  .handler(getManagedUsersImplementation)
;(getManagedUsers as any).__executeImplementation = getManagedUsersImplementation

async function createManagedUserImplementation(
  data: {
    username?: unknown
    password?: unknown
    role?: unknown
    roleId?: unknown
  },
  context: unknown,
) {
  const { default: authService, USER_ROLES } =
    await import('../../../panel-server/services/auth.ts')
  if (
    typeof data.username !== 'string' ||
    !data.username ||
    typeof data.password !== 'string' ||
    !data.password
  ) {
    throwServerError(
      Object.assign(new Error('Username and password are required'), {
        code: 'AUTH_USERNAME_PASSWORD_REQUIRED',
      }),
      400,
    )
  }
  const roleId =
    typeof data.roleId === 'string' && data.roleId.trim()
      ? data.roleId.trim()
      : undefined
  if (!roleId && !USER_ROLES.includes(data.role as string)) {
    throwServerError(
      Object.assign(
        new Error(`role must be one of: ${USER_ROLES.join(', ')}`),
        { code: 'AUTH_INVALID_ROLE' },
      ),
      400,
    )
  }

  try {
    const user = await authService.createUser(
      data.username,
      data.password,
      data.role as string,
      { actingUserId: currentUser(context).userId, roleId },
    )
    const managedUser = ((await authService.getUsers()).find(
      (candidate) => candidate.id === user.id,
    ) ?? user) as unknown as ManagedUserAccount
    return { success: true, user: managedUser }
  } catch (error) {
    throwServerError(error, 400)
  }
}

export const createManagedUser = createServerFn({ method: 'POST' })
  .middleware(usersManageMiddleware)
  .validator(
    (data: {
      username?: unknown
      password?: unknown
      role?: unknown
      roleId?: unknown
    }) => data ?? {},
  )
  .handler(async ({ data, context }) => {
    const result = await createManagedUserImplementation(data, context)
    setResponseStatus(201)
    return result
  })
;(createManagedUser as any).__executeImplementation = createManagedUserImplementation

async function assignManagedUserRoleImplementation(
  data: { userId: string; roleId?: string; role?: string },
  context: unknown,
) {
  try {
    const { default: authService, USER_ROLES } =
      await import('../../../panel-server/services/auth.ts')
    let user
    if (typeof data.roleId === 'string' && data.roleId.trim()) {
      user = await authService.changeUserRoleById(
        String(data.userId),
        data.roleId.trim(),
        { actingUserId: currentUser(context).userId },
      )
    } else {
      if (!USER_ROLES.includes(data.role as string)) {
        throw Object.assign(
          new Error(`role must be one of: ${USER_ROLES.join(', ')}`),
          { code: 'AUTH_INVALID_ROLE' },
        )
      }
      user = await authService.changeUserRole(
        String(data.userId),
        data.role as string,
        { actingUserId: currentUser(context).userId },
      )
    }
    const managedUser = ((await authService.getUsers()).find(
      (candidate) => candidate.id === user.id,
    ) ?? user) as unknown as ManagedUserAccount
    return { success: true, user: managedUser }
  } catch (error) {
    throwServerError(error, 400)
  }
}

export const assignManagedUserRole = createServerFn({ method: 'POST' })
  .middleware(usersManageMiddleware)
  .validator((data: { userId: string; roleId?: string; role?: string }) => data)
  .handler(({ data, context }) =>
    assignManagedUserRoleImplementation(data, context),
  )
;(assignManagedUserRole as any).__executeImplementation = assignManagedUserRoleImplementation

async function removeManagedUserImplementation(
  data: { userId: string },
  context: unknown,
) {
  try {
    const { default: authService } =
      await import('../../../panel-server/services/auth.ts')
    const user = await authService.deleteUser(String(data.userId), {
      actingUserId: currentUser(context).userId,
    })
    return { success: true, user }
  } catch (error) {
    throwServerError(error, 400)
  }
}

export const removeManagedUser = createServerFn({ method: 'POST' })
  .middleware(usersManageMiddleware)
  .validator((data: { userId: string }) => data)
  .handler(({ data, context }) =>
    removeManagedUserImplementation(data, context),
  )
;(removeManagedUser as any).__executeImplementation = removeManagedUserImplementation

async function createManagedRoleImplementation(
  data: { name?: unknown; capabilities?: unknown },
  context: unknown,
) {
  try {
    const { createRole } =
      await import('../../../panel-server/services/permissions.ts')
    const role = await createRole(
      { name: data.name, capabilities: data.capabilities },
      { actingUser: { role: currentUser(context).role } },
    )
    return { success: true, role: role as unknown as RoleInfo }
  } catch (error) {
    throwServerError(error, 500)
  }
}

export const createManagedRole = createServerFn({ method: 'POST' })
    .middleware(rolesManageMiddleware)
    .validator((data: { name?: unknown; capabilities?: unknown }) => data ?? {})
    .handler(async ({ data, context }) => {
      const result = await createManagedRoleImplementation(data, context)
      setResponseStatus(201)
      return result
    })
;(createManagedRole as any).__executeImplementation = createManagedRoleImplementation

async function updateManagedRoleImplementation(
  data: {
    id: string
    name?: unknown
    capabilities?: unknown
    confirmSelfCapabilityLoss?: boolean
  },
  context: unknown,
) {
  try {
    const { updateRole } =
      await import('../../../panel-server/services/permissions.ts')
    const role = await updateRole(
      data.id,
      { name: data.name, capabilities: data.capabilities },
      {
        actingUser: { role: currentUser(context).role },
        confirmSelfCapabilityLoss: data.confirmSelfCapabilityLoss === true,
      },
    )
    return { success: true, role: role as unknown as RoleInfo }
  } catch (error) {
    throwServerError(error, 500)
  }
}

export const updateManagedRole = createServerFn({ method: 'POST' })
    .middleware(rolesManageMiddleware)
    .validator(
      (data: {
        id: string
        name?: unknown
        capabilities?: unknown
        confirmSelfCapabilityLoss?: boolean
      }) => data,
    )
    .handler(({ data, context }) =>
      updateManagedRoleImplementation(data, context),
    )
;(updateManagedRole as any).__executeImplementation = updateManagedRoleImplementation

async function deleteManagedRoleImplementation(
  data: { id: string; reassignTo?: string },
  context: unknown,
) {
  try {
    const { deleteRole } =
      await import('../../../panel-server/services/permissions.ts')
    const result = await deleteRole(data.id, {
      reassignTo: data.reassignTo || undefined,
      actingUser: { role: currentUser(context).role },
    })
    return {
      success: true,
      ...result,
      reassignedTo:
        result.reassignedTo == null ? null : String(result.reassignedTo),
    }
  } catch (error) {
    throwServerError(error, 500)
  }
}

export const deleteManagedRole = createServerFn({ method: 'POST' })
    .middleware(rolesManageMiddleware)
    .validator((data: { id: string; reassignTo?: string }) => data)
    .handler(({ data, context }) =>
      deleteManagedRoleImplementation(data, context),
    )
;(deleteManagedRole as any).__executeImplementation = deleteManagedRoleImplementation

async function getOidcSettingsImplementation(): Promise<OidcSettingsWithEnv> {
  const { getOidcSettings: readOidcSettings, getOidcEnvOverrides } =
    await import('../../../panel-server/services/oidc.ts')
  const settings = await readOidcSettings()
  const requestUrl = currentRequestUrl()
  return {
    ...publicOidcSettings(settings),
    envOverrides:
      getOidcEnvOverrides() as OidcSettingsWithEnv['envOverrides'],
    suggestedRedirectUri: `${requestUrl.protocol}//${requestUrl.host}/api/auth/oidc/callback`,
  }
}

export const getOidcSettings = createServerFn({ method: 'GET' })
  .middleware(panelSettingsMiddleware)
  .handler(getOidcSettingsImplementation)
;(getOidcSettings as any).__executeImplementation = getOidcSettingsImplementation

async function updateOidcSettingsImplementation(data: OidcSettingsUpdate) {
  try {
    const {
      getOidcSettings: readOidcSettings,
      setOidcSettings,
      resetOidcConfigCache,
    } = await import('../../../panel-server/services/oidc.ts')
    const current = await readOidcSettings()
    await setOidcSettings(
      buildOidcUpdates(data, current) as Parameters<
        typeof setOidcSettings
      >[0],
    )
    resetOidcConfigCache()
    return { success: true, ...publicOidcSettings(await readOidcSettings()) }
  } catch (error) {
    throwServerError(error, 500)
  }
}

export const updateOidcSettings = createServerFn({ method: 'POST' })
  .middleware(panelSettingsMiddleware)
  .validator((data: OidcSettingsUpdate) => data ?? {})
  .handler(({ data }) => updateOidcSettingsImplementation(data))
;(updateOidcSettings as any).__executeImplementation = updateOidcSettingsImplementation

async function testOidcConnectionImplementation(
  data: OidcSettingsUpdate,
): Promise<{ success: true; metadata: OidcDiscoveredMetadata }> {
  try {
    const { getOidcSettings: readOidcSettings, testOidcDiscovery } =
      await import('../../../panel-server/services/oidc.ts')
    const current = await readOidcSettings()
    const result = await testOidcDiscovery({
      issuerUrl:
        data.issuerUrl !== undefined
          ? String(data.issuerUrl).trim()
          : current.issuerUrl,
      clientId:
        data.clientId !== undefined
          ? String(data.clientId).trim()
          : current.clientId,
      clientSecret:
        data.clientSecret !== undefined && !isMaskedSecret(data.clientSecret)
          ? String(data.clientSecret)
          : current.clientSecret,
      redirectUri:
        data.redirectUri !== undefined
          ? String(data.redirectUri).trim()
          : current.redirectUri,
      allowInsecureHttp:
        data.allowInsecureHttp !== undefined
          ? Boolean(data.allowInsecureHttp)
          : current.allowInsecureHttp,
    })
    if (result.success === false) {
      throw Object.assign(
        new Error(String(result.error || 'OIDC connection test failed')),
        {
          code: typeof result.code === 'string' ? result.code : undefined,
          params: result.params,
          status: 400,
        },
      )
    }
    return result as { success: true; metadata: OidcDiscoveredMetadata }
  } catch (error) {
    throwServerError(error, 500)
  }
}

export const testOidcConnection = createServerFn({ method: 'POST' })
  .middleware(panelSettingsMiddleware)
  .validator((data: OidcSettingsUpdate) => data ?? {})
  .handler(({ data }) => testOidcConnectionImplementation(data))
;(testOidcConnection as any).__executeImplementation = testOidcConnectionImplementation

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

async function getRecoveryCodesImplementation() {
  try {
    const { default: authService } =
      await import('../../../panel-server/services/auth.ts')
    return await authService.getRecoveryCodeStatus()
  } catch (error) {
    throwServerError(error, 500)
  }
}

export const getRecoveryCodes = createServerFn({ method: 'GET' })
  .middleware(adminRoleMiddleware)
  .handler(getRecoveryCodesImplementation)
;(getRecoveryCodes as any).__executeImplementation = getRecoveryCodesImplementation

async function generateRecoveryCodesImplementation() {
  try {
    const { default: authService } =
      await import('../../../panel-server/services/auth.ts')
    return { success: true, ...(await authService.generateRecoveryCodes(10)) }
  } catch (error) {
    throwServerError(error, 400)
  }
}

export const generateRecoveryCodes = createServerFn({ method: 'POST' })
  .middleware(adminRoleMiddleware)
  .handler(generateRecoveryCodesImplementation)
;(generateRecoveryCodes as any).__executeImplementation = generateRecoveryCodesImplementation

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
