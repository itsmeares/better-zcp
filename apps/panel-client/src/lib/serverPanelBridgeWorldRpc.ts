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
  const implementation = await import('./serverPanelBridgeWorld')
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

export const sendPanelBridgeWorldCommand = createRpc(
  'sendPanelBridgeWorldCommand',
  'POST',
  'server.world_events',
)

export const getPanelBridgeServerInfo = createRpc(
  'getPanelBridgeServerInfo',
  'GET',
  'players.view',
)

export const savePanelBridgeWorld = createRpc(
  'savePanelBridgeWorld',
  'POST',
  'server.control',
)
