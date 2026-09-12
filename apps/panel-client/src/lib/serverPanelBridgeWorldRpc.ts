import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverPanelBridgeWorld.server'
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

export const sendPanelBridgeWorldCommand = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendPanelBridgeWorldCommand,
      'sendPanelBridgeWorldCommand',
      { data, context },
    ),
  )

export const getPanelBridgeServerInfo = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.getPanelBridgeServerInfo,
      'getPanelBridgeServerInfo',
      { data, context },
    ),
  )

export const savePanelBridgeWorld = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.savePanelBridgeWorld, 'savePanelBridgeWorld', {
      data,
      context,
    }),
  )
