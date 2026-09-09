import { createServerFn } from '@tanstack/react-start'
import type { DiskSpaceReport, RuntimeInfo, StorageHealth } from './api'
import { protectedServerFunctionMiddleware } from './serverAuth'

export const getRuntimeInfo = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(async () => {
    const { buildRuntimeInfo } =
      await import('../../../panel-server/routes/system.ts')
    return buildRuntimeInfo() as RuntimeInfo
  })

async function getDiskSpaceReport(): Promise<DiskSpaceReport> {
  const { getDataPaths } = await import('../../../panel-server/utils/paths.ts')
  const { getDiskStatusForPath } =
    await import('../../../panel-server/services/diskMonitor.ts')
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  const runtime = getPanelRuntime()
  return {
    saveVolume: runtime.diskMonitor?.getDiskStatus?.() ?? null,
    panelData: await getDiskStatusForPath(getDataPaths().dataDir),
  }
}

export const getDiskSpace = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(async () => getDiskSpaceReport())

export const getStorageHealth = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(async (): Promise<StorageHealth> => {
    const { getCircuitBreakerStatus } =
      await import('../../../panel-server/database/init.ts')
    const { sanitizeError } =
      await import('../../../panel-server/utils/sanitize.ts')
    const circuitBreaker = getCircuitBreakerStatus()
    return {
      diskSpace: await getDiskSpaceReport(),
      circuitBreaker: {
        ...circuitBreaker,
        lastError: circuitBreaker.lastError
          ? sanitizeError(circuitBreaker.lastError)
          : null,
      },
    }
  })
