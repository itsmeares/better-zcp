import { createServerFn } from '@tanstack/react-start'
import {
  getProtectedApiJson,
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

type AnyRecord = Record<string, any>

type ExecuteOptions = {
  data?: unknown
  context?: unknown
}

type ImplementationFunction = {
  __executeServer?: (
    options: ExecuteOptions,
  ) => Promise<{ result?: unknown; error?: unknown }>
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function capabilityMiddleware(capability: string | string[]) {
  const capabilities = Array.isArray(capability) ? capability : [capability]
  return [
    ...protectedServerFunctionMiddleware,
    ...capabilities.map(permissionMiddleware),
  ] as const
}

async function invoke(name: string, options: ExecuteOptions): Promise<any> {
  const implementation = await import('./serverGameControl')
  const serverFunction = implementation[
    name as keyof typeof implementation
  ] as unknown as ImplementationFunction | undefined
  const executeServer = serverFunction?.__executeServer
  if (!executeServer)
    throw new Error(`Server function ${name} is not available`)
  const outcome = await executeServer(options)
  if (outcome.error) throw outcome.error
  return outcome.result
}

export const getGameServerStatus = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getGameServerStatus', { data, context }),
  )

export const getNetworkInterfaces = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getNetworkInterfaces', { data, context }),
  )

export const getManagedServers = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getManagedServers', { data, context }),
  )

export const getActiveManagedServer = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getActiveManagedServer', { data, context }),
  )

export const getManagedServer = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getManagedServer', { data, context }))

export const saveGameWorld = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.control'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('saveGameWorld', { data, context }))

export const startServer = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.control'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('startServer', { data, context }))

export const stopServer = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.control'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('stopServer', { data, context }))

export const forceStopServer = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.control'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('forceStopServer', { data, context }))

export const restartServer = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.control'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('restartServer', { data, context }))

export const sendServerMessage = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('sendServerMessage', { data, context }),
  )

export const startRain = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('startRain', { data, context }))

export const stopRain = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('stopRain', { data, context }))

export const startStorm = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('startStorm', { data, context }))

export const stopWeather = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('stopWeather', { data, context }))

export const triggerChopper = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('triggerChopper', { data, context }))

export const triggerGunshot = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('triggerGunshot', { data, context }))

export const triggerLightning = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.endanger_or_impersonate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('triggerLightning', { data, context }))

export const triggerThunder = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.endanger_or_impersonate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('triggerThunder', { data, context }))

export const createHorde = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.endanger_or_impersonate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('createHorde', { data, context }))

export const alarm = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('alarm', { data, context }))

export const removeZombies = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('removeZombies', { data, context }))

export const reloadLua = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.configure'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('reloadLua', { data, context }))

export const setLogLevel = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.configure'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('setLogLevel', { data, context }))

export const setServerStats = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.configure'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('setServerStats', { data, context }))

export const releaseSafehouse = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('server.world_events'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('releaseSafehouse', { data, context }))

export const getPlayers = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getPlayers', { data, context }))

export const getWhitelist = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getWhitelist', { data, context }))

export const kickPlayer = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('kickPlayer', { data, context }))

export const banPlayer = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('banPlayer', { data, context }))

export const unbanPlayer = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('unbanPlayer', { data, context }))

export const setAccessLevel = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('setAccessLevel', { data, context }))

export const addToWhitelist = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('addToWhitelist', { data, context }))

export const removeFromWhitelist = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('removeFromWhitelist', { data, context }),
  )

export const addAllowedSteamId = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('addAllowedSteamId', { data, context }),
  )

export const removeAllowedSteamId = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('removeAllowedSteamId', { data, context }),
  )

export const teleportPlayer = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('teleportPlayer', { data, context }))

export const addPlayerItem = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('addPlayerItem', { data, context }))

export const addPlayerXp = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('addPlayerXp', { data, context }))

export const addPlayerVehicle = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('addPlayerVehicle', { data, context }))

export const addPlayerVehicleAt = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('addPlayerVehicleAt', { data, context }),
  )

export const setGodMode = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('setGodMode', { data, context }))

export const setInvisible = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('setInvisible', { data, context }))

export const setNoclip = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.gm_tools'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('setNoclip', { data, context }))

export const getPlayerVehicles = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getPlayerVehicles', { data, context }),
  )

export const getPlayerPerks = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getPlayerPerks', { data, context }))

export const getPlayerAccessLevels = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getPlayerAccessLevels', { data, context }),
  )

export const banSteamId = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('banSteamId', { data, context }))

export const unbanSteamId = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('unbanSteamId', { data, context }))

export const getSteamIdBans = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('players.view'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getSteamIdBans', { data, context }))

export const setVoiceBan = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('setVoiceBan', { data, context }))

export const addRconUser = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('addRconUser', { data, context }))

export const addAllToWhitelist = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('players.moderate'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('addAllToWhitelist', { data, context }),
  )

export const getRconStatus = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getRconStatus', { data, context }))

export const executeRcon = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('rcon.execute'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('executeRcon', { data, context }))

export const connectRcon = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('rcon.execute'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('connectRcon', { data, context }))

export const disconnectRcon = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('rcon.execute'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('disconnectRcon', { data, context }))

export const getRconHistory = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('rcon.execute'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getRconHistory', { data, context }))

export const getRconCommands = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getRconCommands', { data, context }))

export const testRconConnection = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware(['rcon.execute', 'servers.manage']))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('testRconConnection', { data, context }),
  )

export const getSchedulerStatus = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getSchedulerStatus', { data, context }),
  )

export const getSchedulerTasks = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getSchedulerTasks', { data, context }),
  )

export const validateSchedulerCron = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('validateSchedulerCron', { data, context }),
  )

export const createScheduledTask = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('createScheduledTaskAction', { data, context }),
  )

export const updateScheduledTask = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('updateScheduledTaskAction', { data, context }),
  )

export const runScheduledTask = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('runScheduledTask', { data, context }),
  )

export const deleteScheduledTask = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('deleteScheduledTask', { data, context }),
  )

export const restartScheduledServer = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('restartScheduledServer', { data, context }),
  )

export const getSchedulerHistory = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getSchedulerHistory', { data, context }),
  )

export const clearSchedulerHistory = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('clearSchedulerHistory', { data, context }),
  )

export const setSchedulerTimezone = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('setSchedulerTimezone', { data, context }),
  )

export const setSchedulerRestartWarning = createServerFn({ method: 'POST' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('setSchedulerRestartWarning', { data, context }),
  )

export const getSchedulerPresets = createServerFn({ method: 'GET' })
  .middleware(capabilityMiddleware('automation.manage'))
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getSchedulerPresets', { data, context }),
  )

async function withFallback<T>(
  operation: () => Promise<T>,
  endpoint: string,
  signal?: AbortSignal,
  retries?: number,
): Promise<T> {
  try {
    return await operation()
  } catch {
    return getProtectedApiJson<T>(endpoint, signal, retries)
  }
}

export function getGameServerStatusWithFallback(
  signal?: AbortSignal,
  retries?: number,
) {
  return withFallback(
    () => getGameServerStatus(),
    '/server/status',
    signal,
    retries,
  )
}

export function getNetworkInterfacesWithFallback(signal?: AbortSignal) {
  return withFallback(
    () => getNetworkInterfaces(),
    '/server/network-interfaces',
    signal,
  )
}

export function getManagedServersWithFallback(signal?: AbortSignal) {
  return withFallback(() => getManagedServers(), '/servers', signal)
}

export function getActiveManagedServerWithFallback(signal?: AbortSignal) {
  return withFallback(() => getActiveManagedServer(), '/servers/active', signal)
}

export function getManagedServerWithFallback(
  id: string | number,
  signal?: AbortSignal,
) {
  const encodedId = encodeURIComponent(String(id))
  return withFallback(
    () => getManagedServer({ data: { id: String(id) } }),
    `/servers/${encodedId}`,
    signal,
  )
}

export function getPlayersWithFallback(signal?: AbortSignal, retries?: number) {
  return withFallback(() => getPlayers(), '/players', signal, retries)
}

export function getWhitelistWithFallback(signal?: AbortSignal) {
  return withFallback(() => getWhitelist(), '/players/whitelist', signal)
}

export function getPlayerVehiclesWithFallback(signal?: AbortSignal) {
  return withFallback(() => getPlayerVehicles(), '/players/vehicles', signal)
}

export function getPlayerPerksWithFallback(signal?: AbortSignal) {
  return withFallback(() => getPlayerPerks(), '/players/perks', signal)
}

export function getPlayerAccessLevelsWithFallback(signal?: AbortSignal) {
  return withFallback(
    () => getPlayerAccessLevels(),
    '/players/access-levels',
    signal,
  )
}

export function getSteamIdBansWithFallback(signal?: AbortSignal) {
  return withFallback(() => getSteamIdBans(), '/players/steamid-bans', signal)
}

export function getRconStatusWithFallback(signal?: AbortSignal) {
  return withFallback(() => getRconStatus(), '/rcon/status', signal)
}

export function getRconHistoryWithFallback(
  limit?: number,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    limit: String(limit || 100),
  })
  return withFallback(
    () => getRconHistory({ data: { limit } }),
    `/rcon/history?${query.toString()}`,
    signal,
  )
}

export function getRconCommandsWithFallback(signal?: AbortSignal) {
  return withFallback(() => getRconCommands(), '/rcon/commands', signal)
}

export function getSchedulerStatusWithFallback(signal?: AbortSignal) {
  return withFallback(() => getSchedulerStatus(), '/scheduler/status', signal)
}

export function getSchedulerTasksWithFallback(signal?: AbortSignal) {
  return withFallback(() => getSchedulerTasks(), '/scheduler/tasks', signal)
}

export function getSchedulerHistoryWithFallback(
  limit?: number,
  taskId?: number,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (limit) query.set('limit', String(limit))
  if (taskId) query.set('taskId', String(taskId))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return withFallback(
    () => getSchedulerHistory({ data: { limit, taskId } }),
    `/scheduler/history${suffix}`,
    signal,
  )
}

export function getSchedulerPresetsWithFallback(signal?: AbortSignal) {
  return withFallback(
    () => getSchedulerPresets(),
    '/scheduler/cron-presets',
    signal,
  )
}
