import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient()

export const panelQueryKeys = {
  servers: ['servers', 'list'] as const,
  activeServer: ['servers', 'resolved-active'] as const,
  serverStatus: ['server', 'status'] as const,
  serversStatus: ['servers', 'status'] as const,
  activeServerStatus: ['servers', 'active-status'] as const,
  activeServerStatusFor: (serverId: string | number | null | undefined) =>
    [...panelQueryKeys.activeServerStatus, serverId ?? 'none'] as const,
  rconStatuses: ['servers', 'rcon-status'] as const,
  dockerStatus: ['docker', 'status'] as const,
  backupStatus: ['backups', 'status'] as const,
  backups: ['backups', 'list'] as const,
  backupHistory: (serverId: string | number) => ['backups', 'history', serverId] as const,
}
