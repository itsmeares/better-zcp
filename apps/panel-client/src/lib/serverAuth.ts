import { createServerFn } from '@tanstack/react-start'

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
