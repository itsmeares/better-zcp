export type ServerProvider = 'native' | 'docker-local' | 'remote-sftp'

export type LifecycleState =
  | 'stopped'
  | 'starting'
  | 'running-not-ready'
  | 'ready'
  | 'stopping'
  | 'unknown'

export type ClientRunState = 'unknown' | 'running' | 'stopped' | 'transitioning'

export function toClientRunState(state: LifecycleState | string | null | undefined): ClientRunState | null {
  if (state === 'ready') return 'running'
  if (state === 'running-not-ready') return 'transitioning'
  if (state === 'stopped') return 'stopped'
  if (state === 'starting' || state === 'stopping') return 'transitioning'
  if (state === 'unknown') return 'unknown'
  return null
}

export function resolveClientProvider(
  server: { isRemote?: boolean; dockerContainerName?: string | null; dockerContainerId?: string | null } | null | undefined,
): ServerProvider | null {
  if (!server) return null
  if (server.isRemote) return 'remote-sftp'
  if (server.dockerContainerName || server.dockerContainerId) return 'docker-local'
  return 'native'
}

export interface ComposedStatusSignals {
  host: { status: string }
  server: { status: string }
  bridge: { status: string }
}

export function resolveServerCardRunning(
  server: { isActive?: boolean; isRemote?: boolean; dockerContainerName?: string | null; dockerContainerId?: string | null } | null | undefined,
  processStatus: { running?: boolean; stateUnknown?: boolean } | null | undefined,
  composedStatus: ComposedStatusSignals | null | undefined,
): boolean | null {
  if (!server) return null
  const provider = resolveClientProvider(server)

  if (!server.isActive) {
    if (provider !== 'native' || processStatus?.stateUnknown || typeof processStatus?.running !== 'boolean') return null
    return processStatus.running
  }

  if (composedStatus) {
    if (
      composedStatus.host.status === 'running' ||
      composedStatus.server.status === 'connected' ||
      composedStatus.bridge.status === 'active'
    ) return true
    if (composedStatus.host.status === 'stopped' &&
      composedStatus.server.status === 'disconnected' &&
      composedStatus.bridge.status !== 'active') return false
    return null
  }

  if (provider !== 'native' || processStatus?.stateUnknown || typeof processStatus?.running !== 'boolean') return null
  return processStatus.running
}

export interface DashboardStatusInput {
  hasServer: boolean
  provider: string | null
  status: { running?: boolean; scanFailed?: boolean; rcon?: { connected?: boolean } } | null | undefined
  composedStatus: ComposedStatusSignals | null | undefined
}

export interface DashboardStatusOutput {
  hostRunning: boolean
  rconConnected: boolean
  bridgeActive: boolean
  hostUnknown: boolean
  online: boolean
}

export function deriveDashboardStatus({
  hasServer,
  provider,
  status,
  composedStatus,
}: DashboardStatusInput): DashboardStatusOutput {
  const localProcessStatus =
    provider === 'native' && typeof status?.running === 'boolean' && !status?.scanFailed
      ? status.running
      : null
  const hostRunning =
    hasServer &&
    (localProcessStatus ?? (composedStatus ? composedStatus.host.status === 'running' : !!status?.running))
  const rconConnected = composedStatus
    ? composedStatus.server.status === 'connected'
    : Boolean(status?.rcon?.connected)
  const bridgeActive = composedStatus?.bridge.status === 'active'
  const hostUnknown = composedStatus ? ['unknown', 'not-applicable'].includes(composedStatus.host.status) : false
  const online =
    hasServer &&
    (composedStatus
      ? hostRunning || rconConnected || bridgeActive
      : (localProcessStatus ?? !!status?.running))
  return { hostRunning, rconConnected, bridgeActive, hostUnknown, online }
}

export async function resolveServerRunning(
  server: { isRemote?: boolean; dockerContainerName?: string | null } | null | undefined,
  fetchNativeStatus: () => Promise<{ running?: boolean; scanFailed?: boolean }>,
  fetchComposedStatus: () => Promise<ComposedStatusSignals>,
): Promise<boolean | null> {
  const provider = resolveClientProvider(server)
  if (provider == null) return null
  if (provider === 'native') {
    try {
      const status = await fetchNativeStatus()
      if (status.scanFailed) return null
      return Boolean(status.running)
    } catch {
      return null
    }
  }
  try {
    const composed = await fetchComposedStatus()
    const hostRunning = composed.host.status === 'running'
    const rconConnected = composed.server.status === 'connected'
    const bridgeActive = composed.bridge.status === 'active'
    const hostUnknown = ['unknown', 'not-applicable'].includes(composed.host.status)
    if (hostRunning || rconConnected || bridgeActive) return true
    return hostUnknown ? null : false
  } catch {
    return null
  }
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
  { timeoutMs = 30000, pollMs = 1000 }: { timeoutMs?: number; pollMs?: number } = {},
) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const data = await fetchStatus()
      const serverStatus = data.servers?.find((entry) => String(entry.id) === String(serverId))
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
