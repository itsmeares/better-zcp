import { Loader2, WifiOff } from 'lucide-react'
import { useConnectionStatus, useSocket } from '@/contexts/SocketContext'
import { cn } from '@/lib/utils'
import { isDemoMode } from '@/lib/demo'
import { Button } from '@/components/ui/button'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'

const PROXY_HINT =
  "The most common cause is a reverse proxy (nginx, Apache, Caddy, etc.) in front of the panel that isn't forwarding WebSocket upgrade requests. If that matches your setup, ask whoever manages the proxy to confirm it passes through the Upgrade and Connection: upgrade headers."

/** Shown only while the live-update socket is down or reconnecting. */
export function ConnectionStatus() {
  const { connected, reconnecting, reconnectAttempt, error } = useConnectionStatus()
  const socket = useSocket()

  // The demo build has no backend, so there is never a live connection to report.
  if ((connected && !reconnecting) || isDemoMode()) return null

  const status = reconnecting
    ? {
        icon: Loader2,
        tone: 'text-warning-foreground',
        label: 'Reconnecting',
        description: `Attempt ${reconnectAttempt} of 10.`,
        hint:
          reconnectAttempt >= 3
            ? 'This page loaded fine, so the panel server is reachable. Only the live-update connection is having trouble. If it keeps happening and the panel runs behind a reverse proxy, ask whoever manages it to confirm WebSocket upgrades are forwarded.'
            : undefined,
        retry: false,
      }
    : {
        icon: WifiOff,
        tone: 'text-destructive-foreground',
        label: 'Live updates unavailable',
        description:
          "The panel itself is working; you're viewing this page over a working connection. Only the live-update connection couldn't be established.",
        hint: PROXY_HINT,
        retry: true,
      }
  const Icon = status.icon

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn('w-full justify-start group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:justify-center', status.tone)}
          />
        }
      >
        <Icon className={cn(reconnecting && 'animate-spin')} aria-hidden />
        <span className="truncate group-data-[collapsible=icon]:sr-only">{status.label}</span>
      </PopoverTrigger>
      <PopoverPopup side="right" align="end" className="max-w-xs text-sm">
        <p className="font-medium">{status.label}</p>
        <p className="mt-1 text-muted-foreground">{status.description}</p>
        {status.hint && <p className="mt-2 text-muted-foreground">{status.hint}</p>}
        {error && <p className="mt-2 break-all font-mono text-xs text-muted-foreground">Technical detail: {error}</p>}
        {status.retry && (
          <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => socket?.connect()}>
            Retry now
          </Button>
        )}
      </PopoverPopup>
    </Popover>
  )
}
