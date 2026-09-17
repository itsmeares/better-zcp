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
