import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverAuth.server'
import {
  invokeServerFunction,
  type ServerFunctionOptions,
} from './serverFunctionRpc'

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

function invoke<T>(
  serverFunction: unknown,
  name: string,
  options: ServerFunctionOptions,
): Promise<T> {
  return invokeServerFunction<T>(serverFunction, name, options)
}

export const getAuthStatus = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<AuthStatus>(serverImplementation.getAuthStatus, 'getAuthStatus', {
    data,
    context,
  }),
)

export const getOidcStatus = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<OidcStatus>(serverImplementation.getOidcStatus, 'getOidcStatus', {
    data,
    context,
  }),
)

export const getRecoveryStatus = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<RecoveryStatus>(
    serverImplementation.getRecoveryStatus,
    'getRecoveryStatus',
    { data, context },
  ),
)

export const getCurrentUser = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<CurrentUser>(serverImplementation.getCurrentUser, 'getCurrentUser', {
    data,
    context,
  }),
)

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
