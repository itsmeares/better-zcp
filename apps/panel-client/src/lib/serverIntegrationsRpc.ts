import { createServerFn } from '@tanstack/react-start'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

type AnyRecord = Record<string, any>
type ExecuteOptions = {
  data?: unknown
  context?: unknown
}
type ImplementationFunction = {
  __executeImplementation?: (
    data: unknown,
    context?: unknown,
  ) => Promise<unknown>
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
  if (serverFunction?.__executeImplementation) {
    return serverFunction.__executeImplementation(options.data ?? {}, options.context)
  }
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
