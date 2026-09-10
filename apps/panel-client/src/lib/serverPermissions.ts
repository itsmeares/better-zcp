import { createServerFn } from '@tanstack/react-start'
import { rolesReadMiddleware } from './serverAuth'

async function getCapabilitiesImplementation() {
  const { listCapabilitiesGrouped } = await import('../../../panel-server/services/permissions.ts')
  return { groups: listCapabilitiesGrouped() }
}

export const getCapabilities = createServerFn({ method: 'GET' })
    .middleware(rolesReadMiddleware)
    .handler(() => getCapabilitiesImplementation())
;(getCapabilities as any).__executeImplementation = getCapabilitiesImplementation

async function getRolesImplementation() {
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
}

export const getRoles = createServerFn({ method: 'GET' })
    .middleware(rolesReadMiddleware)
    .handler(() => getRolesImplementation())
;(getRoles as any).__executeImplementation = getRolesImplementation
