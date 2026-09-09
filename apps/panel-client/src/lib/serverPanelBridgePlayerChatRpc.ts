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
  __executeServer?: (
    options: ExecuteOptions,
  ) => Promise<{ result?: unknown; error?: unknown }>
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function capabilityMiddleware(capability: string) {
  return [
    ...protectedServerFunctionMiddleware,
    permissionMiddleware(capability),
  ] as const
}

async function invoke(name: string, options: ExecuteOptions): Promise<any> {
  const implementation = await import('./serverPanelBridgePlayerChat')
  const serverFunction = implementation[
    name as keyof typeof implementation
  ] as unknown as ImplementationFunction | undefined
  const executeServer = serverFunction?.__executeServer
  if (!executeServer)
    throw new Error(`Server function ${name} is not available`)
  const outcome = await executeServer(options)
  if (outcome.error) throw outcome.error
  return outcome.result
}

function createRpc(name: string, method: 'GET' | 'POST', capability: string) {
  return createServerFn({ method })
    .middleware(capabilityMiddleware(capability))
    .validator((data: unknown) => record(data))
    .handler(({ data, context }) => invoke(name, { data, context }))
}

export const sendPanelBridgePlayerCommand = createRpc(
  'sendPanelBridgePlayerCommand',
  'POST',
  'players.gm_tools',
)

export const sendPanelBridgeServerMessage = createRpc(
  'sendPanelBridgeServerMessage',
  'POST',
  'server.world_events',
)

export const getPanelBridgeChatInfo = createRpc(
  'getPanelBridgeChatInfo',
  'GET',
  'server.world_events',
)

export const sendPanelBridgeAdminChat = createRpc(
  'sendPanelBridgeAdminChat',
  'POST',
  'players.endanger_or_impersonate',
)

export const sendPanelBridgeGeneralChat = createRpc(
  'sendPanelBridgeGeneralChat',
  'POST',
  'players.endanger_or_impersonate',
)

export const sendPanelBridgeChatAlert = createRpc(
  'sendPanelBridgeChatAlert',
  'POST',
  'server.world_events',
)
