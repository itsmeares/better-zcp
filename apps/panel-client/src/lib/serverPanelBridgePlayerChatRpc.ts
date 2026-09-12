import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverPanelBridgePlayerChat.server'
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

export const sendPanelBridgePlayerCommand = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendPanelBridgePlayerCommand,
      'sendPanelBridgePlayerCommand',
      { data, context },
    ),
  )

export const sendPanelBridgeServerMessage = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendPanelBridgeServerMessage,
      'sendPanelBridgeServerMessage',
      { data, context },
    ),
  )

export const getPanelBridgeChatInfo = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.getPanelBridgeChatInfo,
      'getPanelBridgeChatInfo',
      { data, context },
    ),
  )

export const sendPanelBridgeAdminChat = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendPanelBridgeAdminChat,
      'sendPanelBridgeAdminChat',
      { data, context },
    ),
  )

export const sendPanelBridgeGeneralChat = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendPanelBridgeGeneralChat,
      'sendPanelBridgeGeneralChat',
      { data, context },
    ),
  )

export const sendPanelBridgeChatAlert = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendPanelBridgeChatAlert,
      'sendPanelBridgeChatAlert',
      { data, context },
    ),
  )
