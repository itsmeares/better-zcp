import { createServerFn } from '@tanstack/react-start'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

type AnyRecord = Record<string, any>
type ExecuteOptions = { data?: unknown; context?: unknown }
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

const modsMiddleware = [
  ...protectedServerFunctionMiddleware,
  permissionMiddleware('mods.manage'),
] as const

async function invoke(name: string, options: ExecuteOptions): Promise<any> {
  const implementation = await import('./serverMods')
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

export const getModsStatus = createServerFn({ method: 'GET' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getModsStatus', { data, context }))

export const getTrackedMods = createServerFn({ method: 'GET' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getTrackedMods', { data, context }))

export const trackMod = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('trackMod', { data, context }))

export const untrackMod = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('untrackMod', { data, context }))

export const getIgnoredMods = createServerFn({ method: 'GET' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getIgnoredMods', { data, context }))

export const unignoreMod = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('unignoreMod', { data, context }))

export const clearAllIgnoredMods = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('clearAllIgnoredMods', { data, context }),
  )

export const getIgnoredModPairs = createServerFn({ method: 'GET' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getIgnoredModPairs', { data, context }),
  )

export const addIgnoredModPair = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('addIgnoredModPair', { data, context }),
  )

export const removeIgnoredModPair = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('removeIgnoredModPair', { data, context }),
  )

export const getServerMods = createServerFn({ method: 'GET' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getServerMods', { data, context }))

export const startModChecker = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('startModChecker', { data, context }))

export const stopModChecker = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('stopModChecker', { data, context }))

export const setModAutoRestart = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('setModAutoRestart', { data, context }),
  )

export const setModRestartOptions = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('setModRestartOptions', { data, context }),
  )

export const getWorkshopStatus = createServerFn({ method: 'GET' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('getWorkshopStatus', { data, context }),
  )

export const cancelPendingModRestart = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('cancelPendingModRestart', { data, context }),
  )

export const getModPresets = createServerFn({ method: 'GET' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('getModPresets', { data, context }))

export const updateModPreset = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('updateModPreset', { data, context }))

export const deleteModPreset = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) => invoke('deleteModPreset', { data, context }))

export const addCollectionItem = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('addCollectionItem', { data, context }),
  )

export const removeCollectionItem = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('removeCollectionItem', { data, context }),
  )

export const removeCollectionTracking = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('removeCollectionTracking', { data, context }),
  )

export const saveCollectionCookies = createServerFn({ method: 'POST' })
  .middleware(modsMiddleware)
  .validator((data: unknown) => record(data))
  .handler(({ data, context }) =>
    invoke('saveCollectionCookies', { data, context }),
  )
