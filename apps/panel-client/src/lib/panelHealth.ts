import { queryOptions } from '@tanstack/react-query'
import type { BackendBuildMetadata } from './buildCompatibility'

export const panelHealthQueryKey = ['panel-health'] as const

export async function fetchPanelHealth(signal: AbortSignal): Promise<BackendBuildMetadata> {
  const timeoutController = new AbortController()
  const timeoutId = window.setTimeout(() => timeoutController.abort(), 8_000)
  const abortForQuery = () => timeoutController.abort(signal.reason)

  if (signal.aborted) abortForQuery()
  else signal.addEventListener('abort', abortForQuery, { once: true })

  try {
    const response = await fetch('/api/health', {
      signal: timeoutController.signal,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Health check returned ${response.status}`)
    return await response.json() as BackendBuildMetadata
  } finally {
    window.clearTimeout(timeoutId)
    signal.removeEventListener('abort', abortForQuery)
  }
}

export function panelHealthQueryOptions() {
  return queryOptions({
    queryKey: panelHealthQueryKey,
    queryFn: ({ signal }) => fetchPanelHealth(signal),
    retry: false,
    refetchOnWindowFocus: false,
  })
}
