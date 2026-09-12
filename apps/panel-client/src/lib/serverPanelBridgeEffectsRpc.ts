import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverPanelBridgeEffects.server'
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

export const sendPanelBridgeEndangerCommand = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendPanelBridgeEndangerCommand,
      'sendPanelBridgeEndangerCommand',
      { data, context },
    ),
  )

export const getPanelBridgeCatalog = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.getPanelBridgeCatalog,
      'getPanelBridgeCatalog',
      { data, context },
    ),
  )

export const scanPanelBridgeCatalog = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.scanPanelBridgeCatalog,
      'scanPanelBridgeCatalog',
      { data, context },
    ),
  )
