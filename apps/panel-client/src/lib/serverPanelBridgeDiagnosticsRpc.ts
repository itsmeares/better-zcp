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

async function invoke(options: ExecuteOptions): Promise<any> {
  const implementation = await import('./serverPanelBridgeDiagnostics')
  const serverFunction =
    implementation.sendPanelBridgeDiagnosticsCommand as unknown as ImplementationFunction
  const executeServer = serverFunction.__executeServer
  if (!executeServer) {
    throw new Error(
      'Server function sendPanelBridgeDiagnosticsCommand is not available',
    )
  }
  const outcome = await executeServer(options)
  if (outcome.error) throw outcome.error
  return outcome.result
}

export const sendPanelBridgeDiagnosticsCommand = createServerFn({ method: 'POST' })
  .middleware([
    ...protectedServerFunctionMiddleware,
    permissionMiddleware('bridge.diagnostics'),
  ] as const)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke({ data, context }))
