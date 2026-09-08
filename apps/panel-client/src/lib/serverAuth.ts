import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getAccessToken } from './authToken'

export type AuthStatus = {
  needsSetup: boolean
  authEnabled: boolean
}

export type OidcStatus = {
  configured: boolean
  providerName: string
}

export type RecoveryStatus = {
  recoveryCodesAvailable: boolean
}

export type CurrentUser = {
  user: {
    id: string
    username: string
    role: string
    capabilities: string[] | null
  }
}

export type AuthContextUser = {
  userId: string | null
  username: string | null
  role: string
  tokenGen: number | null
  authDisabled?: boolean
}

const authClientMiddleware = createMiddleware({ type: 'function' }).client(({ next }) => {
  const token = getAccessToken()
  return next(token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
})

const authRequestMiddleware = createMiddleware({ type: 'request' }).server(async ({ request, next }) => {
  const { default: authService } = await import('../../../panel-server/services/auth.ts')
  const result = await authService.authenticateApiRequest(request.headers.get('authorization'))

  if (!result.ok) {
    return Response.json(
      { error: result.error, code: result.code },
      { status: result.status },
    )
  }

  return next({ context: { authenticatedUser: result.user } })
})

function permissionMiddleware(capability: string) {
  return createMiddleware({ type: 'request' }).server(
    async ({ context, next }) => {
      const user = (
        context as unknown as { authenticatedUser?: AuthContextUser }
      ).authenticatedUser
      if (!user) {
        return Response.json(
          { error: 'Authentication required', code: 'AUTH_REQUIRED' },
          { status: 401 },
        )
      }

      const { getCapabilitiesForRole } =
        await import('../../../panel-server/services/permissions.ts')
      const capabilities = await getCapabilitiesForRole(user.role)
      if (!capabilities?.includes(capability)) {
        return Response.json(
          { error: 'Insufficient permissions', code: 'PERMISSION_DENIED' },
          { status: 403 },
        )
      }

      return next()
    },
  )
}

function roleMiddleware(role: string) {
  return createMiddleware({ type: 'request' }).server(
    async ({ context, next }) => {
      const user = (
        context as unknown as { authenticatedUser?: AuthContextUser }
      ).authenticatedUser
      if (!user) {
        return Response.json(
          { error: 'Authentication required', code: 'AUTH_REQUIRED' },
          { status: 401 },
        )
      }
      if (user.role !== role) {
        return Response.json(
          { error: 'Insufficient permissions', code: 'PERMISSION_DENIED' },
          { status: 403 },
        )
      }

      return next()
    },
  )
}

export const protectedServerFunctionMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
] as const

export const rolesReadMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('roles.manage'),
] as const

export const usersManageMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('users.manage'),
] as const

export const rolesManageMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('roles.manage'),
] as const

export const panelSettingsMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('panel.settings'),
] as const

export const diagnosticsMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('diagnostics.manage'),
] as const

export const adminRoleMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  roleMiddleware('admin'),
] as const

export const getAuthStatus = createServerFn({ method: 'GET' }).handler(async () => {
  const { default: authService } = await import('../../../panel-server/services/auth.ts')

  return {
    needsSetup: await authService.needsSetup(),
    authEnabled: await authService.isAuthEnabled(),
  }
})

export const getOidcStatus = createServerFn({ method: 'GET' }).handler(async () => {
  const { getOidcSettings, isOidcConfigured } = await import('../../../panel-server/services/oidc.ts')
  const settings = await getOidcSettings()

  return {
    configured: isOidcConfigured(settings),
    providerName: settings.providerName,
  }
})

export const getRecoveryStatus = createServerFn({ method: 'GET' }).handler(async () => {
  const { default: authService } = await import('../../../panel-server/services/auth.ts')
  const status = await authService.getRecoveryCodeStatus()

  return { recoveryCodesAvailable: status.remaining > 0 }
})

export const getCurrentUser = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(async ({ context }) => {
    const user = (context as { authenticatedUser: AuthContextUser }).authenticatedUser
    if (user.authDisabled || !user.userId || !user.username) {
      throw new Error('Authentication required')
    }

    const { getCapabilitiesForRole } = await import('../../../panel-server/services/permissions.ts')
    return {
      user: {
        id: user.userId,
        username: user.username,
        role: user.role,
        capabilities: await getCapabilitiesForRole(user.role),
      },
    }
  })

export async function getProtectedApiJson<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
  const { apiFetch } = await import('./api.ts')
  const response = await apiFetch(endpoint, signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`Protected API returned ${response.status}`)
  return await response.json() as T
}

export async function getAuthStatusWithFallback(): Promise<AuthStatus> {
  try {
    return await getAuthStatus()
  } catch {
    const response = await fetch('/api/auth/status')
    if (!response.ok) throw new Error(`Auth status returned ${response.status}`)
    return await response.json() as AuthStatus
  }
}

export async function getOidcStatusWithFallback(signal?: AbortSignal): Promise<OidcStatus> {
  try {
    return await getOidcStatus()
  } catch {
    const response = await fetch('/api/auth/oidc/status', signal ? { signal } : undefined)
    if (!response.ok) throw new Error(`OIDC status returned ${response.status}`)
    return await response.json() as OidcStatus
  }
}

export async function getRecoveryStatusWithFallback(signal?: AbortSignal): Promise<RecoveryStatus> {
  try {
    return await getRecoveryStatus()
  } catch {
    const response = await fetch('/api/auth/recovery-status', signal ? { signal } : undefined)
    if (!response.ok) throw new Error(`Recovery status returned ${response.status}`)
    return await response.json() as RecoveryStatus
  }
}

export async function getCurrentUserWithFallback(signal?: AbortSignal): Promise<CurrentUser> {
  try {
    return await getCurrentUser()
  } catch {
    return getProtectedApiJson<CurrentUser>('/auth/me', signal)
  }
}
