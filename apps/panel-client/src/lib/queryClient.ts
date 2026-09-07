import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient()

export const panelQueryKeys = {
  capabilities: ['permissions', 'capabilities'] as const,
  roles: ['permissions', 'roles'] as const,
  users: ['auth', 'users'] as const,
  templates: ['templates'] as const,
  hiddenTemplates: ['templates', 'hidden'] as const,
  oidcSettings: ['auth', 'oidc', 'settings'] as const,
  activeServer: ['servers', 'resolved-active'] as const,
  backupStatus: ['backups', 'status'] as const,
  backups: ['backups', 'list'] as const,
  backupHistory: (serverId: string | number) => ['backups', 'history', serverId] as const,
}
