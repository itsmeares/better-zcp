import type { PanelHealth } from '@/lib/api'

export type HealthTone = 'checking' | 'healthy' | 'servicesDown' | 'issues' | 'unknown'

/** One line that says how the panel and its server are doing. */
export function getHealthHeadline(health: Pick<PanelHealth, 'status' | 'services'> | null): { tone: HealthTone; title: string } {
  if (!health) return { tone: 'checking', title: 'Checking…' }
  if (health.status !== 'ok') return { tone: 'issues', title: 'Issues found' }
  const rconDown = !health.services.rcon.connected
  const running = health.services.server.running
  // A failed process scan is not the same as a stopped server.
  if (typeof running !== 'boolean') {
    return rconDown ? { tone: 'servicesDown', title: 'RCON disconnected, server status unknown' } : { tone: 'unknown', title: 'Server status unknown' }
  }
  if (rconDown && !running) return { tone: 'servicesDown', title: 'RCON disconnected, server stopped' }
  if (rconDown) return { tone: 'servicesDown', title: 'RCON disconnected' }
  if (!running) return { tone: 'servicesDown', title: 'Server stopped' }
  return { tone: 'healthy', title: 'Healthy' }
}
