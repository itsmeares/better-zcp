import { createServerFn, createServerOnlyFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

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

export type RecordData = Record<string, unknown>

const finderMiddleware = [
  ...protectedServerFunctionMiddleware,
  permissionMiddleware('server.install'),
] as const

function record(data: unknown): RecordData {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as RecordData)
    : {}
}

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status })
}

function errorStatus(error: unknown): number {
  const status =
    error && typeof error === 'object' ? (error as { status?: unknown }).status : null
  return typeof status === 'number' && status >= 400 ? status : 500
}

async function sanitizeFailure(error: unknown): Promise<never> {
  const { sanitizeError } =
    await import('../../../panel-server/utils/sanitize.ts')
  const message = error instanceof Error ? error.message : String(error)
  return fail(sanitizeError(message), errorStatus(error))
}

const getServerFinderImplementation = createServerOnlyFn(
  async (data: RecordData): Promise<ServerFinderResponse> => {
    try {
      const { getServerFinderResponse } =
        await import('../../../panel-server/services/serverFinder.ts')
      return (await getServerFinderResponse(
        data.refresh === true,
      )) as ServerFinderResponse
    } catch (error) {
      return sanitizeFailure(error)
    }
  },
)

export const getServerFinder = createServerFn({ method: 'GET' })
    .middleware(finderMiddleware)
    .validator((data: unknown) => record(data))
    .handler(async ({ data }) => {
      try {
        return await getServerFinderImplementation(data)
      } catch (error) {
        setResponseStatus(errorStatus(error))
        throw error
      }
    })
;(getServerFinder as any).__executeImplementation = getServerFinderImplementation

const queryServerFinderImplementation = createServerOnlyFn(
  async (data: RecordData) => {
    const ip = data.ip
    const port = data.port
    if (!ip || !port) fail('IP and port are required', 400)

    const {
      QUERY_FAILURE_MESSAGES,
      parseQueryPort,
      queryFinderServer,
      validateQueryIp,
    } = await import('../../../panel-server/services/serverFinder.ts')
    if (!validateQueryIp(ip)) fail('Invalid or disallowed IP address', 400)
    const portNumber = parseQueryPort(port)
    if (portNumber === null) fail('Invalid port number', 400)

    try {
      const { info, reason } = await queryFinderServer(ip, portNumber)
      if (!info) {
        setResponseStatus(504)
        return {
          success: false,
          error: QUERY_FAILURE_MESSAGES[reason],
          reason,
        }
      }
      return { success: true, server: info }
    } catch (error) {
      return sanitizeFailure(error)
    }
  },
)

export const queryServerFinder = createServerFn({ method: 'GET' })
    .middleware(finderMiddleware)
    .validator((data: unknown) => record(data))
    .handler(async ({ data }) => {
      try {
        return await queryServerFinderImplementation(data)
      } catch (error) {
        setResponseStatus(errorStatus(error))
        throw error
      }
    })
;(queryServerFinder as any).__executeImplementation = queryServerFinderImplementation

const pingServerFinderImplementation = createServerOnlyFn(
  async (data: RecordData): Promise<ServerFinderPingResponse> => {
    const ip = data.ip
    const port = data.port
    if (!ip || !port) fail('IP and port are required', 400)

    const { parseQueryPort, pingFinderServer, validateQueryIp } =
      await import('../../../panel-server/services/serverFinder.ts')
    if (!validateQueryIp(ip)) fail('Invalid or disallowed IP address', 400)
    const portNumber = parseQueryPort(port)
    if (portNumber === null) fail('Invalid port number', 400)
    return (await pingFinderServer(ip, portNumber)) as ServerFinderPingResponse
  },
)

export const pingServerFinder = createServerFn({ method: 'GET' })
    .middleware(finderMiddleware)
    .validator((data: unknown) => record(data))
    .handler(async ({ data }) => {
      try {
        return await pingServerFinderImplementation(data)
      } catch (error) {
        setResponseStatus(errorStatus(error))
        throw error
      }
    })
;(pingServerFinder as any).__executeImplementation = pingServerFinderImplementation

const getServerFinderDebugImplementation = createServerOnlyFn(async () => {
  try {
    const { getServerFinderDebug: readServerFinderDebug } =
      await import('../../../panel-server/services/serverFinder.ts')
    return await readServerFinderDebug()
  } catch (error) {
    return sanitizeFailure(error)
  }
})

export const getServerFinderDebug = createServerFn({ method: 'GET' })
    .middleware(finderMiddleware)
    .handler(async () => {
      try {
        return (await getServerFinderDebugImplementation()) as any
      } catch (error) {
        setResponseStatus(errorStatus(error))
        throw error
      }
    })
;(getServerFinderDebug as any).__executeImplementation = getServerFinderDebugImplementation
