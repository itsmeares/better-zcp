import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverAdmin.server'
import type {
  ConfigTestRconResult,
  ManagedUserAccount,
  OidcDiscoveredMetadata,
  OidcSettings,
  OidcSettingsWithEnv,
  RoleInfo,
} from './api'
import {
  invokeServerFunction,
  type ServerFunctionOptions,
} from './serverFunctionRpc'

type PerformanceHistoryEntry = {
  timestamp: string
  playerCount: number
  memoryUsed: number
  pzMemUsed?: number
  cpuUsage?: number
  hostMemUsed?: number
  hostMemTotal?: number
}

type CorsDiagnostics = {
  diagnostics: Record<string, unknown>
}

function invoke<T>(
  serverFunction: unknown,
  name: string,
  options: ServerFunctionOptions,
): Promise<T> {
  return invokeServerFunction<T>(serverFunction, name, options)
}

export const getManagedUsers = createServerFn({
  method: 'GET',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ users: ManagedUserAccount[] }>(
      serverImplementation.getManagedUsers,
      'getManagedUsers',
      { data, context },
    ),
  )

export const createManagedUser = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean; user: ManagedUserAccount }>(
      serverImplementation.createManagedUser,
      'createManagedUser',
      { data, context },
    ),
  )

export const assignManagedUserRole = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean; user: ManagedUserAccount }>(
      serverImplementation.assignManagedUserRole,
      'assignManagedUserRole',
      { data, context },
    ),
  )

export const removeManagedUser = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean; user: { id: string; username: string } }>(
      serverImplementation.removeManagedUser,
      'removeManagedUser',
      { data, context },
    ),
  )

export const createManagedRole = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean; role: RoleInfo }>(
      serverImplementation.createManagedRole,
      'createManagedRole',
      { data, context },
    ),
  )

export const updateManagedRole = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean; role: RoleInfo }>(
      serverImplementation.updateManagedRole,
      'updateManagedRole',
      { data, context },
    ),
  )

export const deleteManagedRole = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{
      success: boolean
      deleted: boolean
      reassigned: number
      reassignedTo: string | null
    }>(serverImplementation.deleteManagedRole, 'deleteManagedRole', {
      data,
      context,
    }),
  )

export const getOidcSettings = createServerFn({
  method: 'GET',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<OidcSettingsWithEnv>(
      serverImplementation.getOidcSettings,
      'getOidcSettings',
      { data, context },
    ),
  )

export const updateOidcSettings = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean } & OidcSettings>(
      serverImplementation.updateOidcSettings,
      'updateOidcSettings',
      { data, context },
    ),
  )

export const testOidcConnection = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: true; metadata: OidcDiscoveredMetadata }>(
      serverImplementation.testOidcConnection,
      'testOidcConnection',
      { data, context },
    ),
  )

export const getAppSettings = createServerFn({
  method: 'GET',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ settings: Record<string, unknown> }>(
      serverImplementation.getAppSettings,
      'getAppSettings',
      { data, context },
    ),
  )

export const updateAppSettings = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke(serverImplementation.updateAppSettings, 'updateAppSettings', {
      data,
      context,
    }),
  )

export const getCorsDiagnostics = createServerFn({
  method: 'GET',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<CorsDiagnostics>(
      serverImplementation.getCorsDiagnostics,
      'getCorsDiagnostics',
      { data, context },
    ),
  )

export const reloadCorsDiagnostics = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean } & CorsDiagnostics>(
      serverImplementation.reloadCorsDiagnostics,
      'reloadCorsDiagnostics',
      { data, context },
    ),
  )

export const clearCorsBlockedOrigins = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean } & CorsDiagnostics>(
      serverImplementation.clearCorsBlockedOrigins,
      'clearCorsBlockedOrigins',
      { data, context },
    ),
  )

export const testAppRconConnection = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<ConfigTestRconResult>(
      serverImplementation.testAppRconConnection,
      'testAppRconConnection',
      { data, context },
    ),
  )

export const getDebugRam = createServerFn({
  method: 'GET',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{
      totalGB: number
      freeGB: number
      recommendedMin: number
      recommendedMax: number
    }>(serverImplementation.getDebugRam, 'getDebugRam', { data, context }),
  )

export const getPerformanceHistory = createServerFn({
  method: 'GET',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ history: PerformanceHistoryEntry[] }>(
      serverImplementation.getPerformanceHistory,
      'getPerformanceHistory',
      { data, context },
    ),
  )

export const getRecoveryCodes = createServerFn({
  method: 'GET',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{
      configured: boolean
      remaining: number
      total: number
      createdAt: string | null
    }>(serverImplementation.getRecoveryCodes, 'getRecoveryCodes', {
      data,
      context,
    }),
  )

export const generateRecoveryCodes = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean; codes: string[]; createdAt: string }>(
      serverImplementation.generateRecoveryCodes,
      'generateRecoveryCodes',
      { data, context },
    ),
  )

export const changePassword = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean; message?: string }>(
      serverImplementation.changePassword,
      'changePassword',
      { data, context },
    ),
  )

export const regenerateJwtSecret = createServerFn({
  method: 'POST',
  strict: { output: false },
})
  .validator((data: unknown) => data ?? {})
  .handler(({ data, context }) =>
    invoke<{ success: boolean; message?: string }>(
      serverImplementation.regenerateJwtSecret,
      'regenerateJwtSecret',
      { data, context },
    ),
  )
