export type HealthHeadlineTone =
  | 'checking'
  | 'healthy'
  | 'servicesDown'
  | 'issues'
  | 'unknown'

export interface HealthHeadline {
  tone: HealthHeadlineTone
  title: string
}

type HealthStatus = {
  status: 'ok' | 'error'
  services: {
    rcon: { connected: boolean }
    server: { running: boolean | null }
  }
}

export function getHealthHeadline(
  healthStatus: HealthStatus | null,
): HealthHeadline {
  if (!healthStatus) {
    return { tone: 'checking', title: 'Checking...' }
  }
  if (healthStatus.status !== 'ok') {
    return { tone: 'issues', title: 'Issues Detected' }
  }
  const rconDown = !healthStatus.services.rcon.connected
  const serverRunning = healthStatus.services.server.running
  const serverUnknown = typeof serverRunning !== 'boolean'
  const serverDown = serverRunning === false
  if (rconDown && serverUnknown) {
    return {
      tone: 'servicesDown',
      title: 'RCON Disconnected · Server Status Unknown',
    }
  }
  if (serverUnknown) {
    return { tone: 'unknown', title: 'Server Status Unknown' }
  }
  if (rconDown && serverDown) {
    return {
      tone: 'servicesDown',
      title: 'RCON Disconnected · Game Server Stopped',
    }
  }
  if (rconDown) {
    return { tone: 'servicesDown', title: 'RCON Disconnected' }
  }
  if (serverDown) {
    return { tone: 'servicesDown', title: 'Game Server Stopped' }
  }
  return { tone: 'healthy', title: 'Healthy' }
}
