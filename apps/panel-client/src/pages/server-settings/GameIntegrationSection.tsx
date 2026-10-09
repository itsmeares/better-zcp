import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { gameIntegrationApi, type GameIntegrationStatus } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { SocketContext } from '@/contexts/SocketContext'
import { GameIntegrationStatusBadge } from '@/components/GameIntegrationStatusBadge'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { toastManager } from '@/components/ui/toast'

export function GameIntegrationSection() {
  const socket = useContext(SocketContext)
  const [status, setStatus] = useState<GameIntegrationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const loaded = useRef(false)

  const refresh = useCallback(async () => {
    if (!loaded.current) setLoading(true)
    try {
      setStatus(await gameIntegrationApi.getStatus())
      setError(null)
    } catch (err) {
      reportClientError('Failed to fetch game integration status.', err)
      setError(getUserErrorMessage(err, "Couldn't load the game integration status."))
    } finally {
      loaded.current = true
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh()
    }, 10000)
    return () => clearInterval(interval)
  }, [refresh])

  useEffect(() => {
    if (!socket) return
    const onChange = () => void refresh()
    socket.on('gameIntegration:status', onChange)
    return () => {
      socket.off('gameIntegration:status', onChange)
    }
  }, [socket, refresh])

  const install = async () => {
    setInstalling(true)
    try {
      const result = await gameIntegrationApi.install()
      if (!result.success) throw new Error(result.error || 'Installation failed.')
      toastManager.add({
        title: 'Game integration installed',
        description: result.data?.restartRequired ? 'Restart the game server to load it.' : result.message || 'This server is up to date.',
        type: 'success',
      })
      await refresh()
    } catch (err) {
      toastManager.add({ title: 'Installation failed', description: getUserErrorMessage(err, "The panel couldn't install the game integration."), type: 'error' })
    } finally {
      setInstalling(false)
    }
  }

  const install_ = status?.localInstall
  // The server repeats the summary as the only issue while waiting.
  const issues = (status?.connection?.issues ?? []).filter((issue) => issue !== status?.connection?.summary)

  return (
    <SettingsCard
      title="Game integration"
      description="A small server mod that sends live player details and lets the panel heal, teleport and read sandbox settings."
      action={<GameIntegrationStatusBadge connected={status?.modConnected === true} running={status?.isRunning === true} loading={loading} summary={status?.connection?.summary} interactive={false} />}
    >
      {error && (
        <div className="pt-4">
          <Alert variant="error">
            <AlertTitle>Status unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}
      <SettingsRow
        label="Connection"
        description={
          <>
            {status?.connection?.summary || 'Waiting for the game server to report live data.'}
            {status?.modConnected && status.modStatus && (
              <span className="block">
                {status.modStatus.serverName} · version {status.modStatus.version} · {status.modStatus.playerCount} online
              </span>
            )}
            {issues.length > 0 && (
              <ul className="mt-1 list-disc ps-5">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </>
        }
      >
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Installation"
        description={
          <>
            {install_?.installed ? (install_.needsUpdate ? 'An update is available for this server.' : 'Installed on this server.') : 'Not installed on this server yet.'}
            {install_?.restartRequired && <span className="block text-warning-foreground">Restart the game server to load the installed version.</span>}
            {install_ && !install_.canAutoInstall && <span className="block">The panel can't install it automatically for this server.</span>}
          </>
        }
      >
        <Button size="sm" onClick={() => void install()} disabled={installing || !install_?.canAutoInstall}>
          {installing ? <Loader2 className="animate-spin" /> : <Download />}
          {install_?.needsUpdate ? 'Install update' : 'Install'}
        </Button>
      </SettingsRow>
    </SettingsCard>
  )
}
