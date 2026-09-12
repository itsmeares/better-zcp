import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverFinder.server'
import {
  invokeServerFunction,
  type ServerFunctionOptions,
} from './serverFunctionRpc'

export type ServerFinderServer = {
  name: string
  ip: string
  port: number | null
  gamePort?: number | null
  players: number
  maxPlayers: number
  map: string
  version: string
  vac: boolean
  isPrivate: boolean
  os: string
  dedicated?: boolean
  bots?: number
  keywords?: string
  tags?: string[]
  ping?: number | null
}

export type ServerFinderResponse = {
  success: true
  servers: ServerFinderServer[]
  source: string
  cached: boolean
  count: number
  totalPlayers: number
  activeServers: number
  totalCapacity: number
  apiKeyConfigured: boolean
  emptyReason?: string
}

export type ServerFinderPingResponse = {
  success: true
  ping: number | null
  online: boolean
  reason?: string
}

function record(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {}
}

function invoke<T>(
  serverFunction: unknown,
  name: string,
  options: ServerFunctionOptions,
): Promise<T> {
  return invokeServerFunction<T>(serverFunction, name, options)
}

export const getServerFinder = createServerFn({
  method: 'GET',
  strict: { output: false },
})
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke<ServerFinderResponse>(
      serverImplementation.getServerFinder,
      'getServerFinder',
      { data, context },
    ),
  )

export const pingServerFinder = createServerFn({
  method: 'GET',
  strict: { output: false },
})
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke<ServerFinderPingResponse>(
      serverImplementation.pingServerFinder,
      'pingServerFinder',
      { data, context },
    ),
  )
