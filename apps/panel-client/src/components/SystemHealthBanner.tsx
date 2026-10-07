import { useCallback, useContext, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, ShieldAlert, X } from 'lucide-react'
import { SocketContext } from '@/contexts/SocketContext'
import { systemApi, type StorageHealth } from '@/lib/api'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

const POLL_INTERVAL_MS = 30_000
const DISK_SOCKET_EVENTS = [
  'disk:warning',
  'disk:critical',
  'disk:normal',
] as const

type Level = 'warning' | 'critical'

interface Banner {
  level: Level
  title: string
  message: string
  dismissible: boolean
}

function deriveBanner(health: StorageHealth | null): Banner | null {
  if (!health) return null
  const { diskSpace, database } = health
  const save = diskSpace?.saveVolume

  if (database?.ok === false) {
    return {
      level: 'critical',
      title: 'Panel database needs attention',
      message: database.error || 'Panel database unavailable',
      dismissible: false,
    }
  }
  if (save?.critical) {
    return {
      level: 'critical',
      title: 'Save volume critical',
      message: String(save.usedPercent) + '% used',
      dismissible: false,
    }
  }
  if (save?.warning) {
    return {
      level: 'warning',
      title: 'Save volume warning',
      message: String(save.usedPercent) + '% used',
      dismissible: true,
    }
  }
  return null
}

export function SystemHealthBanner() {
  const [health, setHealth] = useState<StorageHealth | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const socket = useContext(SocketContext)
  const navigate = useNavigate()

  const refresh = useCallback(() => {
    systemApi
      .getStorageHealth()
      .then((next) => {
        setHealth((prev) => {
          if (!prev) return next
          const saveVolume =
            next.diskSpace.saveVolume?.ok === false
              ? prev.diskSpace.saveVolume
              : next.diskSpace.saveVolume
          const panelData =
            next.diskSpace.panelData.ok === false
              ? prev.diskSpace.panelData
              : next.diskSpace.panelData
          return { ...next, diskSpace: { saveVolume, panelData } }
        })
      })
      .catch(() => {
        /* keep last-known state */
      })
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [refresh])

  useEffect(() => {
    if (!socket) return
    DISK_SOCKET_EVENTS.forEach((evt) => socket.on(evt, refresh))
    return () => {
      DISK_SOCKET_EVENTS.forEach((evt) => socket.off(evt, refresh))
    }
  }, [socket, refresh])

  const banner = deriveBanner(health)

  useEffect(() => {
    if (!banner) setDismissed(false)
  }, [banner])

  if (!banner || (dismissed && banner.dismissible)) return null

  const isCritical = banner.level === 'critical'
  const Icon = isCritical ? ShieldAlert : AlertTriangle

  return (
    <Alert
      variant={isCritical ? 'error' : 'warning'}
      role={isCritical ? 'alert' : 'status'}
      aria-live={isCritical ? 'assertive' : 'polite'}
    >
      <Icon aria-hidden />
      <AlertTitle>{banner.title}</AlertTitle>
      <AlertDescription>{banner.message}</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" onClick={() => void navigate({ to: '/diagnostics' })}>
          Diagnostics
        </Button>
        {banner.dismissible && (
          <Button size="icon-xs" variant="ghost" onClick={() => setDismissed(true)} aria-label="Dismiss storage warning">
            <X aria-hidden />
          </Button>
        )}
      </AlertAction>
    </Alert>
  )
}
