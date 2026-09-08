import { createServerFn } from '@tanstack/react-start'

export type AuthStatus = {
  needsSetup: boolean
  authEnabled: boolean
}

export const getAuthStatus = createServerFn({ method: 'GET' }).handler(async () => {
  const { default: authService } = await import('../../../panel-server/services/auth.ts')

  return {
    needsSetup: await authService.needsSetup(),
    authEnabled: await authService.isAuthEnabled(),
  }
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
