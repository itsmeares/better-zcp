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

export type CurrentUser = {
  user: {
    id: string
    username: string
    role: string
    capabilities: string[] | null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseAuthStatus(value: unknown): AuthStatus {
  if (
    !isRecord(value) ||
    typeof value.needsSetup !== 'boolean' ||
    typeof value.authEnabled !== 'boolean'
  ) {
    throw new Error('Auth status response was invalid')
  }
  return {
    needsSetup: value.needsSetup,
    authEnabled: value.authEnabled,
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
    return parseAuthStatus(await getAuthStatus())
  } catch {
    const response = await fetch('/api/auth/status')
    if (!response.ok) throw new Error(`Auth status returned ${response.status}`)
    return parseAuthStatus(await response.json())
  }
}
