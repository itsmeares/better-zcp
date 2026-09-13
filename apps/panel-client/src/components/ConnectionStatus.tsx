import { Wifi, WifiOff, Loader2 } from 'lucide-react'
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

export function ConnectionStatus({
  className,
  showLabel = false,
}: ConnectionStatusProps) {
  const { connected, reconnecting, reconnectAttempt, error } =
    useConnectionStatus()
  const socket = useSocket()

  if (connected && !reconnecting) return null

  const getStatusInfo = () => {
    if (connected) {
      return {
        icon: Wifi,
        color: 'text-primary',
        surface: 'border-primary/20 bg-primary/10',
        label: 'Connected',
        description: 'Real-time updates active',
      }
    }
    if (reconnecting) {
      return {
        icon: Loader2,
        color: 'text-warning',
        surface: 'border-warning/24 bg-warning/10',
        label: 'Reconnecting...',
        description: 'Attempt ' + String(reconnectAttempt) + '/10',
        hint:
          reconnectAttempt >= 3
            ? 'This page loaded fine, so the panel server is reachable — only this live-update connection is having trouble. If it keeps happening and the panel runs behind a reverse proxy (nginx, Apache, Caddy, etc.), ask whoever manages it to confirm WebSocket upgrades are forwarded.'
            : undefined,
        animate: true,
      }
    }
    return {
      icon: WifiOff,
      color: 'text-destructive',
      surface: 'border-destructive/24 bg-destructive/10',
      label: 'Live Updates Unavailable',
      description:
        "The panel itself is working — you're viewing this page over a working connection. Only the live-update connection couldn't be established.",
      hint: "The most common cause is a reverse proxy (nginx, Apache, Caddy, etc.) in front of the panel that isn't forwarding WebSocket upgrade requests. If that matches your setup, ask whoever manages the proxy to confirm it passes through the Upgrade and Connection: upgrade headers.",
      technicalDetail: error ? 'Technical detail: ' + String(error) : undefined,
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
            className,
          )}
        >
          <Icon
            className={cn(
              'h-4 w-4',
              status.color,
              status.animate && 'animate-spin',
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
              {'Retry now'}
            </Button>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
