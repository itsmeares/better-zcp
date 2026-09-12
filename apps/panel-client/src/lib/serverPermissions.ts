import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverPermissions.server'
import type { CapabilityGroup, RoleInfo } from './api'
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

export const getCapabilities = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<{ groups: CapabilityGroup[] }>(
    serverImplementation.getCapabilities,
    'getCapabilities',
    { data, context },
  ),
)

export const getRoles = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<{ roles: RoleInfo[] }>(serverImplementation.getRoles, 'getRoles', {
    data,
    context,
  }),
)
