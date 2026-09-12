import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverPanelBridgeDiagnostics.server'
import { invokeServerFunction } from './serverFunctionRpc'
type AnyRecord = Record<string, any>

type ExecuteOptions = {
  data?: unknown
  context?: unknown
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function invoke(
  serverFunction: unknown,
  name: string,
  options: ExecuteOptions,
): Promise<any> {
  return invokeServerFunction(serverFunction, name, options)
}

export const sendPanelBridgeDiagnosticsCommand = createServerFn({
  method: 'POST',
})
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendPanelBridgeDiagnosticsCommand,
      'sendPanelBridgeDiagnosticsCommand',
      { data, context },
    ),
  )
