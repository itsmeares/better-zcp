import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverIntegrations.server'
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

export const getDiscordStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getDiscordStatus, 'getDiscordStatus', {
      data,
      context,
    }),
  )

export const getDiscordConfig = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getDiscordConfig, 'getDiscordConfig', {
      data,
      context,
    }),
  )

export const updateDiscordConfig = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.updateDiscordConfig, 'updateDiscordConfig', {
      data,
      context,
    }),
  )

export const startDiscordBot = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.startDiscordBot, 'startDiscordBot', {
      data,
      context,
    }),
  )

export const stopDiscordBot = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.stopDiscordBot, 'stopDiscordBot', {
      data,
      context,
    }),
  )

export const resetDiscordConfig = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.resetDiscordConfig, 'resetDiscordConfig', {
      data,
      context,
    }),
  )

export const testDiscordToken = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.testDiscordToken, 'testDiscordToken', {
      data,
      context,
    }),
  )

export const sendDiscordTestMessage = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.sendDiscordTestMessage,
      'sendDiscordTestMessage',
      { data, context },
    ),
  )

export const getDiscordWebhookEvents = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.getDiscordWebhookEvents,
      'getDiscordWebhookEvents',
      { data, context },
    ),
  )

export const updateDiscordWebhookEvents = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.updateDiscordWebhookEvents,
      'updateDiscordWebhookEvents',
      { data, context },
    ),
  )

export const getDiscordPermissions = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.getDiscordPermissions,
      'getDiscordPermissions',
      { data, context },
    ),
  )

export const updateDiscordPermissions = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.updateDiscordPermissions,
      'updateDiscordPermissions',
      { data, context },
    ),
  )

export const getDockerStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getDockerStatus, 'getDockerStatus', {
      data,
      context,
    }),
  )

export const getDockerStats = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getDockerStats, 'getDockerStats', {
      data,
      context,
    }),
  )

export const runDockerAction = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.runDockerAction, 'runDockerAction', {
      data,
      context,
    }),
  )
