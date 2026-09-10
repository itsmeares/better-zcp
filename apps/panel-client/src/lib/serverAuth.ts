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

export function permissionMiddleware(capability: string) {
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

export function anyPermissionMiddleware(...capabilities: string[]) {
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
      const roleCapabilities = await getCapabilitiesForRole(user.role)
      if (!roleCapabilities?.some((capability) => capabilities.includes(capability))) {
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

async function getAuthStatusImplementation() {
  const { default: authService } = await import('../../../panel-server/services/auth.ts')

  return {
    needsSetup: await authService.needsSetup(),
    authEnabled: await authService.isAuthEnabled(),
  }
}

export const getAuthStatus = createServerFn({ method: 'GET' }).handler(
  getAuthStatusImplementation,
)
;(getAuthStatus as any).__executeImplementation = getAuthStatusImplementation

async function getOidcStatusImplementation() {
  const { getOidcSettings, isOidcConfigured } = await import('../../../panel-server/services/oidc.ts')
  const settings = await getOidcSettings()

  return {
    configured: isOidcConfigured(settings),
    providerName: settings.providerName,
  }
}

export const getOidcStatus = createServerFn({ method: 'GET' }).handler(
  getOidcStatusImplementation,
)
;(getOidcStatus as any).__executeImplementation = getOidcStatusImplementation

async function getRecoveryStatusImplementation() {
  const { default: authService } = await import('../../../panel-server/services/auth.ts')
  const status = await authService.getRecoveryCodeStatus()

  return { recoveryCodesAvailable: status.remaining > 0 }
}

export const getRecoveryStatus = createServerFn({ method: 'GET' }).handler(
  getRecoveryStatusImplementation,
)
;(getRecoveryStatus as any).__executeImplementation = getRecoveryStatusImplementation

async function getCurrentUserImplementation(context: unknown) {
  const user = (context as { authenticatedUser: AuthContextUser }).authenticatedUser
  if (user.authDisabled || !user.userId || !user.username) {
    throw Object.assign(new Error('Not authenticated'), {
      status: 401,
      code: 'NOT_AUTHENTICATED',
    })
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
}

export const getCurrentUser = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(({ context }) => getCurrentUserImplementation(context))
;(getCurrentUser as any).__executeImplementation = (
  _data: unknown,
  context: unknown,
) => getCurrentUserImplementation(context)
