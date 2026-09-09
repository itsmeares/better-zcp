import { createServerFn } from '@tanstack/react-start'
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

type RecordData = Record<string, unknown>

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
  setResponseStatus(status)
  throw Object.assign(new Error(message), { status })
}

async function sanitizeFailure(error: unknown): Promise<never> {
  const { sanitizeError } =
    await import('../../../panel-server/utils/sanitize.ts')
  const message = error instanceof Error ? error.message : String(error)
  return fail(sanitizeError(message), 500)
}

export const getServerFinder = createServerFn({ method: 'GET' })
  .middleware(finderMiddleware)
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => {
    try {
      const { getServerFinderResponse } =
        await import('../../../panel-server/services/serverFinder.ts')
      return (await getServerFinderResponse(
        data.refresh === true,
      )) as ServerFinderResponse
    } catch (error) {
      return sanitizeFailure(error)
    }
  })

export const queryServerFinder = createServerFn({ method: 'GET' })
  .middleware(finderMiddleware)
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => {
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
  })

export const pingServerFinder = createServerFn({ method: 'GET' })
  .middleware(finderMiddleware)
  .validator((data: unknown) => record(data))
  .handler(async ({ data }) => {
    const ip = data.ip
    const port = data.port
    if (!ip || !port) fail('IP and port are required', 400)

    const { parseQueryPort, pingFinderServer, validateQueryIp } =
      await import('../../../panel-server/services/serverFinder.ts')
    if (!validateQueryIp(ip)) fail('Invalid or disallowed IP address', 400)
    const portNumber = parseQueryPort(port)
    if (portNumber === null) fail('Invalid port number', 400)
    return (await pingFinderServer(ip, portNumber)) as ServerFinderPingResponse
  })

async function fallbackJson<T>(
  endpoint: string,
  signal?: AbortSignal,
): Promise<T> {
  const { apiFetch, ApiError } = await import('./api')
  const response = await apiFetch(endpoint, signal ? { signal } : undefined)
  const payload = await response.json().catch(() => null)
  if (
    !response.ok ||
    !payload ||
    typeof payload !== 'object' ||
    ('success' in payload && payload.success === false)
  ) {
    const details = payload && typeof payload === 'object' ? payload : {}
    throw new ApiError(
      'error' in details && typeof details.error === 'string'
        ? details.error
        : `HTTP ${response.status}`,
      {
        status: response.status,
        code:
          'code' in details && typeof details.code === 'string'
            ? details.code
            : undefined,
        data: payload,
      },
    )
  }
  return payload as T
}

export async function getServerFinderWithFallback(
  forceRefresh = false,
  signal?: AbortSignal,
): Promise<ServerFinderResponse> {
  try {
    const result = await getServerFinder({ data: { refresh: forceRefresh } })
    if (result === undefined) throw new Error('Server function unavailable')
    return result as ServerFinderResponse
  } catch {
    return fallbackJson<ServerFinderResponse>(
      forceRefresh ? '/server-finder?refresh=true' : '/server-finder',
      signal,
    )
  }
}

export async function queryServerFinderWithFallback(
  ip: string,
  port: number,
  signal?: AbortSignal,
) {
  try {
    return await queryServerFinder({ data: { ip, port } })
  } catch {
    return fallbackJson(
      `/server-finder/query?ip=${encodeURIComponent(ip)}&port=${port}`,
      signal,
    )
  }
}

export async function pingServerFinderWithFallback(
  ip: string,
  port: number,
  signal?: AbortSignal,
): Promise<ServerFinderPingResponse> {
  try {
    return (await pingServerFinder({
      data: { ip, port },
    })) as ServerFinderPingResponse
  } catch {
    return fallbackJson<ServerFinderPingResponse>(
      `/server-finder/ping?ip=${encodeURIComponent(ip)}&port=${port}`,
      signal,
    )
  }
}
