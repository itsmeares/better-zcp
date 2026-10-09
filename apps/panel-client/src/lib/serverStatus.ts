export type ServerProvider = 'native' | 'docker-local'

export type LifecycleState =
  | 'stopped'
  | 'starting'
  | 'running-not-ready'
  | 'ready'
  | 'stopping'
  | 'unknown'

export type ClientRunState = 'unknown' | 'running' | 'stopped' | 'transitioning'

export function toClientRunState(
  state: LifecycleState | string | null | undefined,
): ClientRunState | null {
  if (state === 'ready') return 'running'
  if (state === 'running-not-ready') return 'transitioning'
  if (state === 'stopped') return 'stopped'
  if (state === 'starting' || state === 'stopping') return 'transitioning'
  if (state === 'unknown') return 'unknown'
  return null
}

export function resolveClientProvider(
  server:
    | {
        dockerContainerName?: string | null
        dockerContainerId?: string | null
      }
    | null
    | undefined,
): ServerProvider | null {
  if (!server) return null
  if (server.dockerContainerName || server.dockerContainerId)
    return 'docker-local'
  return 'native'
}

export interface ComposedStatusSignals {
  host: { status: string }
  server: { status: string }
  gameIntegration: { status: string }
}

export function resolveServerCardRunning(
  server:
    | {
        isActive?: boolean
        dockerContainerName?: string | null
        dockerContainerId?: string | null
      }
    | null
    | undefined,
  processStatus:
    { running?: boolean; stateUnknown?: boolean } | null | undefined,
  composedStatus: ComposedStatusSignals | null | undefined,
): boolean | null {
  if (!server) return null
  const provider = resolveClientProvider(server)

  if (!server.isActive) {
    if (
      provider !== 'native' ||
      processStatus?.stateUnknown ||
      typeof processStatus?.running !== 'boolean'
    )
      return null
    return processStatus.running
  }

  if (composedStatus) {
    if (
      composedStatus.host.status === 'running' ||
      composedStatus.server.status === 'connected' ||
      composedStatus.gameIntegration.status === 'active'
    )
      return true
    if (
      composedStatus.host.status === 'stopped' &&
      composedStatus.server.status === 'disconnected' &&
      composedStatus.gameIntegration.status !== 'active'
    )
      return false
    return null
  }

  if (
    provider !== 'native' ||
    processStatus?.stateUnknown ||
    typeof processStatus?.running !== 'boolean'
  )
    return null
  return processStatus.running
}

export interface ServerStatusEntry {
  id: string | number
  running: boolean
  pid: string | null
}

export interface ServerStatusResponse {
  servers: ServerStatusEntry[]
}

export async function waitForServerState(
  fetchStatus: () => Promise<ServerStatusResponse>,
  serverId: string | number,
  expectedRunning: boolean,
  onStatus?: (status: ServerStatusEntry) => void,
  {
    timeoutMs = 30000,
    pollMs = 1000,
  }: { timeoutMs?: number; pollMs?: number } = {},
) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const data = await fetchStatus()
      const serverStatus = data.servers?.find(
        (entry) => String(entry.id) === String(serverId),
      )
      if (serverStatus) {
        onStatus?.(serverStatus)
        if (serverStatus.running === expectedRunning) return true
      }
    } catch {
      // A short process transition can briefly interrupt the status endpoint.
    }

    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }
}
