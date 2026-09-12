import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverGameControl.server'
import { invokeServerFunction } from './serverFunctionRpc'
type AnyRecord = Record<string, any>

type ExecuteOptions = {
  data?: unknown
  context?: unknown
}
function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function invoke(
  serverFunction: unknown,
  name: string,
  options: ExecuteOptions,
): Promise<any> {
  return invokeServerFunction(serverFunction, name, options)
}

export const getGameServerStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getGameServerStatus, 'getGameServerStatus', {
      data,
      context,
    }),
  )

export const getNetworkInterfaces = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getNetworkInterfaces, 'getNetworkInterfaces', {
      data,
      context,
    }),
  )

export const getManagedServers = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getManagedServers, 'getManagedServers', {
      data,
      context,
    }),
  )

export const getActiveManagedServer = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.getActiveManagedServer,
      'getActiveManagedServer',
      { data, context },
    ),
  )

export const getManagedServer = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getManagedServer, 'getManagedServer', {
      data,
      context,
    }),
  )

export const createManagedServer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.createManagedServer, 'createManagedServer', {
      data,
      context,
    }),
  )

export const updateManagedServer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.updateManagedServer, 'updateManagedServer', {
      data,
      context,
    }),
  )

export const deleteManagedServer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.deleteManagedServer, 'deleteManagedServer', {
      data,
      context,
    }),
  )

export const activateManagedServer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.activateManagedServer,
      'activateManagedServer',
      { data, context },
    ),
  )

export const getLifecycleTemplate = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getLifecycleTemplate, 'getLifecycleTemplate', {
      data,
      context,
    }),
  )

export const activateManagedLifecycleProvider = createServerFn({
  method: 'POST',
})
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.activateManagedLifecycleProvider,
      'activateManagedLifecycleProvider',
      { data, context },
    ),
  )

export const getDiscoveredMounts = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getDiscoveredMounts, 'getDiscoveredMounts', {
      data,
      context,
    }),
  )

export const createServerFromDiscovery = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.createServerFromDiscovery,
      'createServerFromDiscovery',
      { data, context },
    ),
  )

export const saveGameWorld = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.saveGameWorld, 'saveGameWorld', {
      data,
      context,
    }),
  )

export const startServer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.startServer, 'startServer', { data, context }),
  )

export const stopServer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.stopServer, 'stopServer', { data, context }),
  )

export const forceStopServer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.forceStopServer, 'forceStopServer', {
      data,
      context,
    }),
  )

export const restartServer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.restartServer, 'restartServer', {
      data,
      context,
    }),
  )

export const sendServerMessage = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.sendServerMessage, 'sendServerMessage', {
      data,
      context,
    }),
  )

export const startRain = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.startRain, 'startRain', { data, context }),
  )

export const stopRain = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.stopRain, 'stopRain', { data, context }),
  )

export const startStorm = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.startStorm, 'startStorm', { data, context }),
  )

export const stopWeather = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.stopWeather, 'stopWeather', { data, context }),
  )

export const triggerChopper = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.triggerChopper, 'triggerChopper', {
      data,
      context,
    }),
  )

export const triggerGunshot = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.triggerGunshot, 'triggerGunshot', {
      data,
      context,
    }),
  )

export const triggerLightning = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.triggerLightning, 'triggerLightning', {
      data,
      context,
    }),
  )

export const triggerThunder = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.triggerThunder, 'triggerThunder', {
      data,
      context,
    }),
  )

export const createHorde = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.createHorde, 'createHorde', { data, context }),
  )

export const alarm = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.alarm, 'alarm', { data, context }),
  )

export const removeZombies = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.removeZombies, 'removeZombies', {
      data,
      context,
    }),
  )

export const reloadLua = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.reloadLua, 'reloadLua', { data, context }),
  )

export const setLogLevel = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setLogLevel, 'setLogLevel', { data, context }),
  )

export const setServerStats = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setServerStats, 'setServerStats', {
      data,
      context,
    }),
  )

export const releaseSafehouse = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.releaseSafehouse, 'releaseSafehouse', {
      data,
      context,
    }),
  )

export const getPlayers = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getPlayers, 'getPlayers', { data, context }),
  )

export const getWhitelist = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getWhitelist, 'getWhitelist', {
      data,
      context,
    }),
  )

export const kickPlayer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.kickPlayer, 'kickPlayer', { data, context }),
  )

export const banPlayer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.banPlayer, 'banPlayer', { data, context }),
  )

export const unbanPlayer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.unbanPlayer, 'unbanPlayer', { data, context }),
  )

export const setAccessLevel = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setAccessLevel, 'setAccessLevel', {
      data,
      context,
    }),
  )

export const addToWhitelist = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addToWhitelist, 'addToWhitelist', {
      data,
      context,
    }),
  )

export const removeFromWhitelist = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.removeFromWhitelist, 'removeFromWhitelist', {
      data,
      context,
    }),
  )

export const addAllowedSteamId = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addAllowedSteamId, 'addAllowedSteamId', {
      data,
      context,
    }),
  )

export const removeAllowedSteamId = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.removeAllowedSteamId, 'removeAllowedSteamId', {
      data,
      context,
    }),
  )

export const teleportPlayer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.teleportPlayer, 'teleportPlayer', {
      data,
      context,
    }),
  )

export const addPlayerItem = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addPlayerItem, 'addPlayerItem', {
      data,
      context,
    }),
  )

export const addPlayerXp = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addPlayerXp, 'addPlayerXp', { data, context }),
  )

export const addPlayerVehicle = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addPlayerVehicle, 'addPlayerVehicle', {
      data,
      context,
    }),
  )

export const addPlayerVehicleAt = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addPlayerVehicleAt, 'addPlayerVehicleAt', {
      data,
      context,
    }),
  )

export const setGodMode = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setGodMode, 'setGodMode', { data, context }),
  )

export const setInvisible = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setInvisible, 'setInvisible', {
      data,
      context,
    }),
  )

export const setNoclip = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setNoclip, 'setNoclip', { data, context }),
  )

export const getPlayerVehicles = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getPlayerVehicles, 'getPlayerVehicles', {
      data,
      context,
    }),
  )

export const getPlayerPerks = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getPlayerPerks, 'getPlayerPerks', {
      data,
      context,
    }),
  )

export const getPlayerAccessLevels = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.getPlayerAccessLevels,
      'getPlayerAccessLevels',
      { data, context },
    ),
  )

export const banSteamId = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.banSteamId, 'banSteamId', { data, context }),
  )

export const unbanSteamId = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.unbanSteamId, 'unbanSteamId', {
      data,
      context,
    }),
  )

export const getSteamIdBans = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getSteamIdBans, 'getSteamIdBans', {
      data,
      context,
    }),
  )

export const setVoiceBan = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setVoiceBan, 'setVoiceBan', { data, context }),
  )

export const addRconUser = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addRconUser, 'addRconUser', { data, context }),
  )

export const addAllToWhitelist = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addAllToWhitelist, 'addAllToWhitelist', {
      data,
      context,
    }),
  )

export const getRconStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getRconStatus, 'getRconStatus', {
      data,
      context,
    }),
  )

export const executeRcon = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.executeRcon, 'executeRcon', { data, context }),
  )

export const connectRcon = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.connectRcon, 'connectRcon', { data, context }),
  )

export const disconnectRcon = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.disconnectRcon, 'disconnectRcon', {
      data,
      context,
    }),
  )

export const getRconHistory = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getRconHistory, 'getRconHistory', {
      data,
      context,
    }),
  )

export const getRconCommands = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getRconCommands, 'getRconCommands', {
      data,
      context,
    }),
  )

export const getRconHealth = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getRconHealth, 'getRconHealth', {
      data,
      context,
    }),
  )

export const testRconConnection = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.testRconConnection, 'testRconConnection', {
      data,
      context,
    }),
  )

export const getSchedulerStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getSchedulerStatus, 'getSchedulerStatus', {
      data,
      context,
    }),
  )

export const getSchedulerTasks = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getSchedulerTasks, 'getSchedulerTasks', {
      data,
      context,
    }),
  )

export const validateSchedulerCron = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.validateSchedulerCron,
      'validateSchedulerCron',
      { data, context },
    ),
  )

export const createScheduledTask = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.createScheduledTaskAction,
      'createScheduledTaskAction',
      { data, context },
    ),
  )

export const updateScheduledTask = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.updateScheduledTaskAction,
      'updateScheduledTaskAction',
      { data, context },
    ),
  )

export const runScheduledTask = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.runScheduledTask, 'runScheduledTask', {
      data,
      context,
    }),
  )

export const deleteScheduledTask = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.deleteScheduledTask, 'deleteScheduledTask', {
      data,
      context,
    }),
  )

export const restartScheduledServer = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.restartScheduledServer,
      'restartScheduledServer',
      { data, context },
    ),
  )

export const getSchedulerHistory = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getSchedulerHistory, 'getSchedulerHistory', {
      data,
      context,
    }),
  )

export const clearSchedulerHistory = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.clearSchedulerHistory,
      'clearSchedulerHistory',
      { data, context },
    ),
  )

export const setSchedulerTimezone = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setSchedulerTimezone, 'setSchedulerTimezone', {
      data,
      context,
    }),
  )

export const setSchedulerRestartWarning = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.setSchedulerRestartWarning,
      'setSchedulerRestartWarning',
      { data, context },
    ),
  )

export const getSchedulerPresets = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getSchedulerPresets, 'getSchedulerPresets', {
      data,
      context,
    }),
  )
