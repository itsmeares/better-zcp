import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverSystem.server'
import type { DiskSpaceReport, RuntimeInfo, StorageHealth } from './api'
import {
  invokeServerFunction,
  type ServerFunctionOptions,
} from './serverFunctionRpc'

function invoke<T>(
  serverFunction: unknown,
  name: string,
  options: ServerFunctionOptions,
): Promise<T> {
  return invokeServerFunction<T>(serverFunction, name, options)
}

export const getRuntimeInfo = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<RuntimeInfo>(serverImplementation.getRuntimeInfo, 'getRuntimeInfo', {
    data,
    context,
  }),
)

export const getDiskSpace = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<DiskSpaceReport>(serverImplementation.getDiskSpace, 'getDiskSpace', {
    data,
    context,
  }),
)

export const getStorageHealth = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<StorageHealth>(
    serverImplementation.getStorageHealth,
    'getStorageHealth',
    { data, context },
  ),
)
