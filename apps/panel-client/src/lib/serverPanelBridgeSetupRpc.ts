import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverPanelBridgeSetup.server'
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

export const getPanelBridgeStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getPanelBridgeStatus, 'getPanelBridgeStatus', {
      data,
      context,
    }),
  )

export const pingPanelBridge = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.pingPanelBridge, 'pingPanelBridge', {
      data,
      context,
    }),
  )

export const sendPanelBridgeSetupCommand = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendPanelBridgeSetupCommand,
      'sendPanelBridgeSetupCommand',
      { data, context },
    ),
  )
