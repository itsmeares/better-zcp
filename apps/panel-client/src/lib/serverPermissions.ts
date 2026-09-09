import { createServerFn } from '@tanstack/react-start'
import { rolesReadMiddleware } from './serverAuth'

export const getCapabilities = createServerFn({ method: 'GET' })
  .middleware(rolesReadMiddleware)
  .handler(async () => {
    const { listCapabilitiesGrouped } = await import('../../../panel-server/services/permissions.ts')
    return { groups: listCapabilitiesGrouped() }
  })

export const getRoles = createServerFn({ method: 'GET' })
  .middleware(rolesReadMiddleware)
  .handler(async () => {
    const { listRolesWithMemberCounts } = await import('../../../panel-server/services/permissions.ts')
    const roles = await listRolesWithMemberCounts()
    return {
      roles: roles.map((role) => ({
        id: String(role.id),
        name: role.name,
        capabilities: role.capabilities,
        isSeeded: role.isSeeded === true,
        createdAt: typeof role.createdAt === 'string' ? role.createdAt : '',
        ...(typeof role.updatedAt === 'string' ? { updatedAt: role.updatedAt } : {}),
        memberCount: role.memberCount,
      })),
    }
  })
