import { useCallback, useEffect, useState } from 'react'
import { ApiError, configApi, rconApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'

export type RconFailure = 'unreachable' | 'auth_failed' | 'dropped'

export interface RconResult {
  success: boolean
  response?: string
  error?: string
}

/** RCON reachability for the selected server, updated by every command the console sends. */
export function useRconLink(configured: boolean) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [failure, setFailure] = useState<RconFailure | null>(null)
  const [checking, setChecking] = useState(false)

  const recheck = useCallback(async () => {
    if (!configured) return
    setChecking(true)
    try {
      const result = await configApi.testRcon()
      setConnected(Boolean(result.success && result.connected))
      setFailure(null)
    } catch (error) {
      const data = error instanceof ApiError ? (error.data as { error?: string } | undefined) : undefined
      setConnected(false)
      setFailure(data?.error === 'auth_failed' ? 'auth_failed' : 'unreachable')
    } finally {
      setChecking(false)
    }
  }, [configured])

  useEffect(() => {
    if (configured) void recheck()
    else setConnected(null)
  }, [configured, recheck])

  const execute = useCallback(async (command: string): Promise<RconResult> => {
    let result: RconResult & { code?: string }
    try {
      result = await rconApi.execute(command)
    } catch (error) {
      result = {
        success: false,
        error: getUserErrorMessage(error, 'The command failed.'),
        code: error instanceof ApiError ? error.code : undefined,
      }
    }
    if (result.code === 'RCON_EXECUTE_DISCONNECTED') {
      setConnected(false)
      setFailure('dropped')
    } else if (result.success) {
      setConnected(true)
      setFailure(null)
    }
    return result
  }, [])

  const markConnected = useCallback(() => setConnected(true), [])

  return { configured, connected, failure, checking, recheck, execute, markConnected }
}

export type RconLink = ReturnType<typeof useRconLink>
