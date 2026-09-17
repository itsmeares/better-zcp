import { createServerFn } from '@tanstack/react-start'
import { protectedServerFunctionMiddleware } from './serverAuth.server'

type AnyRecord = Record<string, any>

type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  params?: unknown
  status?: unknown
  missing?: unknown
  success?: unknown
  valid?: unknown
  detail?: unknown
  reason?: unknown
}

interface ManagedDockerContainer {
  Id: string
  Names?: string[]
  Image?: string
  State?: { Running?: boolean }
  Status?: string
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const details = error as ServiceError
    if (typeof details.error === 'string') return details.error
    if (typeof details.message === 'string') return details.message
  }
  return String(error)
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/[A-Z]:\\[^\s'")\]>}]+/gi, '[path]')
    .replace(/[A-Z]:\/[^\s'")\]>}]+/gi, '[path]')
    .replace(/\\\\[^\s'")\]>}]+/gi, '[path]')
    .replace(
      /\/(?:home|opt|usr|var|tmp|srv|root|etc|mnt|media)\/[^\s'")\]>}]+/gi,
      '[path]',
    )
}

function sanitizeParams(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params
  const sanitized: AnyRecord = {}
  for (const [key, value] of Object.entries(params)) {
    sanitized[key] = typeof value === 'string' ? sanitizeMessage(value) : value
  }
  return sanitized
}

function throwIntegrationError(error: unknown, fallbackStatus = 500): never {
  const details =
    error && typeof error === 'object' ? (error as ServiceError) : {}
  const status =
    typeof details.status === 'number' ? details.status : fallbackStatus
  throw Object.assign(new Error(sanitizeMessage(errorMessage(error))), {
    status,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(details.params !== undefined
      ? { params: sanitizeParams(details.params) }
      : {}),
    ...(details.missing !== undefined ? { missing: details.missing } : {}),
    ...(details.success === false ? { success: false } : {}),
    ...(details.valid === false ? { valid: false } : {}),
    ...(typeof details.detail === 'string'
      ? { detail: sanitizeMessage(details.detail) }
      : {}),
    ...(typeof details.reason === 'string'
      ? { reason: sanitizeMessage(details.reason) }
      : {}),
  })
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

function createIntegrationRead<T>(
  handler: (data: AnyRecord, context: unknown) => Promise<T> | T,
) {
  const implementation = async (
    data: AnyRecord,
    context: unknown,
  ): Promise<T> => {
    try {
      return (await handler(data, context)) as T
    } catch (error) {
      throwIntegrationError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'GET' })
      .middleware(protectedServerFunctionMiddleware)
      .validator((data: unknown) => record(data))
      .handler(({ data, context }) => implementation(data, context) as any),
    { __executeImplementation: implementation },
  )
}

function createIntegrationAction<T>(
  handler: (data: AnyRecord, context: unknown) => Promise<T> | T,
) {
  const implementation = async (
    data: AnyRecord,
    context: unknown,
  ): Promise<T> => {
    try {
      return (await handler(data, context)) as T
    } catch (error) {
      throwIntegrationError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'POST' })
      .middleware(protectedServerFunctionMiddleware)
      .validator((data: unknown) => record(data))
      .handler(({ data, context }) => implementation(data, context) as any),
    { __executeImplementation: implementation },
  )
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++
        results[index] = await mapper(items[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}

export const getDockerStatus = createIntegrationRead(async () => {
    const dockerClient = (await panelRuntime()).dockerClient
    if (!dockerClient?.enabled) {
      return { enabled: false, available: false, containers: [] }
    }

    const containers =
      (await dockerClient.listManagedContainers()) as ManagedDockerContainer[]
    return {
      enabled: true,
      available: dockerClient.available,
      ...(dockerClient.lastError
        ? { error: sanitizeMessage(dockerClient.lastError) }
        : {}),
      containers: containers.map((container) => ({
        id: container.Id,
        name: (container.Names?.[0] || '').replace(/^\//, ''),
        image: container.Image,
        state: container.State,
        status: container.Status,
      })),
    }
})

export const getDockerStats = createIntegrationRead(async () => {
    const dockerClient = (await panelRuntime()).dockerClient
    if (!dockerClient?.enabled || !dockerClient.available) {
      return { containers: {} }
    }

    const containers =
      (await dockerClient.listManagedContainers()) as ManagedDockerContainer[]
    const samples = await mapWithConcurrency(
      containers,
      3,
      async (container) => ({
        container,
        stats: await dockerClient.getContainerStats(container.Id),
      }),
    )
    const result: Record<string, unknown> = {}
    for (const { container, stats } of samples) {
      if (!stats) continue
      result[container.Id] = stats
      const name = (container.Names?.[0] || '').replace(/^\//, '')
      if (name) result[name] = stats
    }
    return { containers: result }
})

export const runDockerAction = createIntegrationAction(async (data) => {
    const { acquireLifecycleLock, lifecycleInProgressResponse } =
      await import('../../../panel-server/services/lifecycleCoordinator.ts')
    const id = String(data.id ?? '')
    const action = String(data.action ?? '')
    const lifecycleLock = acquireLifecycleLock('docker-' + action, id || null)
    if (!lifecycleLock) {
      throwIntegrationError(lifecycleInProgressResponse(), 409)
    }

    let rconService: AnyRecord | null = null
    try {
      const dockerClient = (await panelRuntime()).dockerClient
      if (!dockerClient?.enabled || !dockerClient.available) {
        throwIntegrationError(
          Object.assign(new Error('Docker control is unavailable'), {
            code: 'DOCKER_UNAVAILABLE',
          }),
          503,
        )
      }

    const { getServer } = await import('../../../panel-server/database/init.ts')
      const server = await getServer(data.serverId)
      if (!server) {
        throwIntegrationError(
          Object.assign(new Error('Server profile not found'), {
            code: 'SERVER_PROFILE_NOT_FOUND',
          }),
          404,
        )
      }
    if (server.dockerContainerName !== id && server.dockerContainerId !== id) {
        throwIntegrationError(
          Object.assign(new Error('Container is not mapped to this server'), {
            code: 'CONTAINER_NOT_MAPPED',
          }),
          403,
        )
      }

      const container = await dockerClient.inspectManagedContainer(id)
      if (!container) {
        throwIntegrationError(
          Object.assign(new Error('Container is not managed by this panel'), {
            code: 'CONTAINER_NOT_MANAGED',
          }),
          403,
        )
      }

      if (['stop', 'restart'].includes(action) && container.State?.Running) {
        const { RconService } =
          await import('../../../panel-server/services/rcon.ts')
        rconService = new RconService()
        await rconService.loadConfig(String(server.id))
        if (!(await rconService.connect())) {
          throwIntegrationError(
            Object.assign(
              new Error('RCON connection failed; container was not changed'),
              { code: 'DOCKER_ACTION_RCON_CONNECT_FAILED' },
            ),
            409,
          )
        }
        const saved = await rconService.save({ skipLog: true })
        if (!saved?.success) {
          const reason = saved?.error || 'unknown error'
          throwIntegrationError(
            Object.assign(new Error('World save failed: ' + reason), {
              code: 'DOCKER_ACTION_SAVE_FAILED',
              params: { reason },
            }),
            409,
          )
        }
      }

      const result = await dockerClient.runManagedAction(id, action)
      if (!result.success) {
        throwIntegrationError(
          Object.assign(new Error(sanitizeMessage(result.error || '')), result),
          403,
        )
      }
      return result
    } finally {
      if (rconService?.connected) {
        await rconService.disconnect().catch(() => {})
      }
      lifecycleLock.release()
    }
})
