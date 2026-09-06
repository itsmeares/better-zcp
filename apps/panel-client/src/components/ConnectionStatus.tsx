import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useConnectionStatus, useSocket } from '@/contexts/SocketContext'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface ConnectionStatusProps {
  className?: string
  showLabel?: boolean
}

export function ConnectionStatus({ className, showLabel = false }: ConnectionStatusProps) {
  const { t } = useTranslation('connectionStatus')
  const { connected, reconnecting, reconnectAttempt, error } = useConnectionStatus()
  const socket = useSocket()

  // Only show when not connected — a permanently visible "Connected" badge is noise
  if (connected && !reconnecting) return null

  // Reaching this component's render at all means the page itself loaded
  // over HTTP successfully -- so a stuck reconnect or a terminal disconnect
  // is never proof the panel/server is down, only that THIS live-update
  // connection specifically can't establish. A generic wifi-off icon with
  // no explanation reads as "the panel is broken" to a non-technical
  // operator; naming the likely cause (most commonly a reverse proxy not
  // forwarding WebSocket upgrades) turns this into something they can act
  // on or hand to whoever runs their proxy, without asserting it as fact --
  // plenty of other things can cause a socket to fail to connect.
  const getStatusInfo = () => {
    if (connected) {
      return {
        icon: Wifi,
        color: 'text-primary',
        surface: 'border-primary/20 bg-primary/10',
        label: t('connected.label'),
        description: t('connected.description'),
      }
    }
    if (reconnecting) {
      return {
        icon: Loader2,
        color: 'text-warning',
        surface: 'border-warning/24 bg-warning/10',
        label: t('reconnecting.label'),
        description: t('reconnecting.description', { attempt: reconnectAttempt }),
        // Only after a few attempts -- a single retry is normal network
        // noise, not evidence of a proxy misconfiguration worth surfacing.
        hint: reconnectAttempt >= 3 ? t('reconnecting.hint') : undefined,
        animate: true,
      }
    }
    return {
      icon: WifiOff,
      color: 'text-destructive',
      surface: 'border-destructive/24 bg-destructive/10',
      label: t('disconnected.label'),
      description: t('disconnected.description'),
      hint: t('disconnected.hint'),
      technicalDetail: error ? t('disconnected.technicalDetail', { error }) : undefined,
      // The automatic reconnect loop has already given up by the time this
      // renders (App.tsx's reconnect_failed handler). It retries on its own
      // once the tab becomes visible again or the network comes back, but
      // an operator staring at a live, visible, network-fine tab the whole
      // time has neither of those events to rescue them -- this button is
      // their only path back short of a full page refresh. Calls the exact
      // same socket.connect(), which re-checks/refreshes the access token
      // first via the socket's auth function -- not a second, separate
      // reconnect implementation.
      showRetry: true,
    }
  }

  const status = getStatusInfo()
  const Icon = status.icon

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div 
          className={cn(
            'flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors',
            status.surface,
            connected && 'conn-status-breathing',
            className
          )}
        >
          <Icon 
            className={cn(
              'h-4 w-4',
              status.color,
              status.animate && 'animate-spin'
            )}
            aria-hidden="true"
          />
          {showLabel && (
            <span className="text-sm font-medium text-foreground">
              {status.label}
            </span>
          )}
          {!showLabel && <span className="sr-only">{status.label}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="text-sm max-w-xs">
          <p className="font-medium">{status.label}</p>
          <p className="text-muted-foreground">{status.description}</p>
          {status.hint && (
            <p className="text-muted-foreground mt-1.5">{status.hint}</p>
          )}
          {status.technicalDetail && (
            <p className="text-muted-foreground/70 font-mono text-xs mt-1.5 break-all">
              {status.technicalDetail}
            </p>
          )}
          {status.showRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2 h-7 w-full text-xs"
              onClick={() => socket?.connect()}
            >
              {t('disconnected.retry')}
            </Button>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
