import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverMods.server'
import { invokeServerFunction } from './serverFunctionRpc'
type AnyRecord = Record<string, any>
type ExecuteOptions = { data?: unknown; context?: unknown }
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

export const getModsStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getModsStatus, 'getModsStatus', {
      data,
      context,
    }),
  )

export const getTrackedMods = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getTrackedMods, 'getTrackedMods', {
      data,
      context,
    }),
  )

export const trackMod = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.trackMod, 'trackMod', { data, context }),
  )

export const untrackMod = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.untrackMod, 'untrackMod', { data, context }),
  )

export const getIgnoredMods = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getIgnoredMods, 'getIgnoredMods', {
      data,
      context,
    }),
  )

export const unignoreMod = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.unignoreMod, 'unignoreMod', { data, context }),
  )

export const clearAllIgnoredMods = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.clearAllIgnoredMods, 'clearAllIgnoredMods', {
      data,
      context,
    }),
  )

export const getIgnoredModPairs = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getIgnoredModPairs, 'getIgnoredModPairs', {
      data,
      context,
    }),
  )

export const addIgnoredModPair = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addIgnoredModPair, 'addIgnoredModPair', {
      data,
      context,
    }),
  )

export const removeIgnoredModPair = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.removeIgnoredModPair, 'removeIgnoredModPair', {
      data,
      context,
    }),
  )

export const getServerMods = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getServerMods, 'getServerMods', {
      data,
      context,
    }),
  )

export const startModChecker = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.startModChecker, 'startModChecker', {
      data,
      context,
    }),
  )

export const stopModChecker = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.stopModChecker, 'stopModChecker', {
      data,
      context,
    }),
  )

export const setModAutoRestart = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setModAutoRestart, 'setModAutoRestart', {
      data,
      context,
    }),
  )

export const setModRestartOptions = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.setModRestartOptions, 'setModRestartOptions', {
      data,
      context,
    }),
  )

export const getWorkshopStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getWorkshopStatus, 'getWorkshopStatus', {
      data,
      context,
    }),
  )

export const cancelPendingModRestart = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.cancelPendingModRestart,
      'cancelPendingModRestart',
      { data, context },
    ),
  )

export const getModPresets = createServerFn({ method: 'GET' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.getModPresets, 'getModPresets', {
      data,
      context,
    }),
  )

export const updateModPreset = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.updateModPreset, 'updateModPreset', {
      data,
      context,
    }),
  )

export const deleteModPreset = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.deleteModPreset, 'deleteModPreset', {
      data,
      context,
    }),
  )

export const addCollectionItem = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.addCollectionItem, 'addCollectionItem', {
      data,
      context,
    }),
  )

export const removeCollectionItem = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(serverImplementation.removeCollectionItem, 'removeCollectionItem', {
      data,
      context,
    }),
  )

export const removeCollectionTracking = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.removeCollectionTracking,
      'removeCollectionTracking',
      { data, context },
    ),
  )

export const saveCollectionCookies = createServerFn({ method: 'POST' })
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke(
      serverImplementation.saveCollectionCookies,
      'saveCollectionCookies',
      { data, context },
    ),
  )
