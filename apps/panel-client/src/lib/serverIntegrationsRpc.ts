import { createServerFn } from '@tanstack/react-start'
import {
  getProtectedApiJson,
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

type AnyRecord = Record<string, any>
type ExecuteOptions = {
  data?: unknown
  context?: unknown
}
type ImplementationFunction = {
  __executeServer?: (
    options: ExecuteOptions,
  ) => Promise<{ result?: unknown; error?: unknown }>
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function middleware(capability: string) {
  return [
    ...protectedServerFunctionMiddleware,
    permissionMiddleware(capability),
  ] as const
}

async function invoke(name: string, options: ExecuteOptions): Promise<any> {
  const implementation = await import('./serverIntegrations')
  const serverFunction = implementation[
    name as keyof typeof implementation
  ] as unknown as ImplementationFunction | undefined
  const executeServer = serverFunction?.__executeServer
  if (!executeServer)
    throw new Error('Server function ' + name + ' is not available')
  const outcome = await executeServer(options)
  if (outcome.error) throw outcome.error
  return outcome.result
}

function createIntegrationRpc(
  name: string,
  method: 'GET' | 'POST',
  capability: string,
) {
  return createServerFn({ method })
    .middleware(middleware(capability))
    .validator((data: unknown) => record(data))
    .handler(({ data, context }) => invoke(name, { data, context }))
}

export const getDiscordStatus = createIntegrationRpc(
  'getDiscordStatus',
  'GET',
  'integrations.manage',
)
export const getDiscordConfig = createIntegrationRpc(
  'getDiscordConfig',
  'GET',
  'integrations.manage',
)
export const updateDiscordConfig = createIntegrationRpc(
  'updateDiscordConfig',
  'POST',
  'integrations.manage',
)
export const startDiscordBot = createIntegrationRpc(
  'startDiscordBot',
  'POST',
  'integrations.manage',
)
export const stopDiscordBot = createIntegrationRpc(
  'stopDiscordBot',
  'POST',
  'integrations.manage',
)
export const resetDiscordConfig = createIntegrationRpc(
  'resetDiscordConfig',
  'POST',
  'integrations.manage',
)
export const testDiscordToken = createIntegrationRpc(
  'testDiscordToken',
  'POST',
  'integrations.manage',
)
export const sendDiscordTestMessage = createIntegrationRpc(
  'sendDiscordTestMessage',
  'POST',
  'integrations.manage',
)
export const getDiscordWebhookEvents = createIntegrationRpc(
  'getDiscordWebhookEvents',
  'GET',
  'integrations.manage',
)
export const updateDiscordWebhookEvents = createIntegrationRpc(
  'updateDiscordWebhookEvents',
  'POST',
  'integrations.manage',
)
export const getDiscordPermissions = createIntegrationRpc(
  'getDiscordPermissions',
  'GET',
  'integrations.manage',
)
export const updateDiscordPermissions = createIntegrationRpc(
  'updateDiscordPermissions',
  'POST',
  'integrations.manage',
)
export const getDockerStatus = createIntegrationRpc(
  'getDockerStatus',
  'GET',
  'docker.manage',
)
export const getDockerStats = createIntegrationRpc(
  'getDockerStats',
  'GET',
  'docker.manage',
)
export const runDockerAction = createIntegrationRpc(
  'runDockerAction',
  'POST',
  'docker.manage',
)

async function withFallback<T>(
  operation: () => Promise<T>,
  endpoint: string,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await operation()
  } catch {
    return getProtectedApiJson<T>(endpoint, signal)
  }
}

export function getDiscordStatusWithFallback(signal?: AbortSignal) {
  return withFallback(() => getDiscordStatus(), '/discord/status', signal)
}

export function getDiscordConfigWithFallback(signal?: AbortSignal) {
  return withFallback(() => getDiscordConfig(), '/discord/config', signal)
}

export function getDiscordWebhookEventsWithFallback(signal?: AbortSignal) {
  return withFallback(
    () => getDiscordWebhookEvents(),
    '/discord/webhook-events',
    signal,
  )
}

export function getDiscordPermissionsWithFallback(signal?: AbortSignal) {
  return withFallback(
    () => getDiscordPermissions(),
    '/discord/permissions',
    signal,
  )
}

export function getDockerStatusWithFallback(signal?: AbortSignal) {
  return withFallback(() => getDockerStatus(), '/docker/status', signal)
}

export function getDockerStatsWithFallback(signal?: AbortSignal) {
  return withFallback(() => getDockerStats(), '/docker/stats', signal)
}
