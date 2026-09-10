import { createServerFn } from '@tanstack/react-start'
import {
  anyPermissionMiddleware,
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

function middleware(capability?: string) {
  return capability
    ? ([
        ...protectedServerFunctionMiddleware,
        permissionMiddleware(capability),
      ] as const)
    : protectedServerFunctionMiddleware
}

async function invoke(name: string, options: ExecuteOptions): Promise<any> {
  const implementation = await import('./serverPanelBridgeSetup')
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

function createRpc(name: string, method: 'GET' | 'POST', capability?: string) {
  return createServerFn({ method })
    .middleware(middleware(capability))
    .validator((data: unknown) => record(data))
    .handler(({ data, context }) => invoke(name, { data, context }))
}

export const getPanelBridgeStatus = createServerFn({ method: 'GET' })
  .middleware([
    ...protectedServerFunctionMiddleware,
    anyPermissionMiddleware('bridge.setup', 'bridge.diagnostics'),
  ] as const)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getPanelBridgeStatus', { data, context }))

export const pingPanelBridge = createRpc('pingPanelBridge', 'GET')

export const sendPanelBridgeSetupCommand = createRpc(
  'sendPanelBridgeSetupCommand',
  'POST',
  'bridge.setup',
)
