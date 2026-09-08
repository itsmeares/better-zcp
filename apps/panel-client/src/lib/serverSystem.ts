import { createServerFn } from '@tanstack/react-start'
import type { RuntimeInfo } from './api'
import {
  getProtectedApiJson,
  protectedServerFunctionMiddleware,
} from './serverAuth'

export const getRuntimeInfo = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(async () => {
    const { buildRuntimeInfo } = await import('../../../panel-server/routes/system.ts')
    return buildRuntimeInfo() as RuntimeInfo
  })

export async function getRuntimeInfoWithFallback(signal?: AbortSignal): Promise<RuntimeInfo> {
  try {
    return await getRuntimeInfo()
  } catch {
    return getProtectedApiJson<RuntimeInfo>('/system/runtime', signal)
  }
}
