import { Link } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { RconLink } from './useRconLink'

const FAILURE_COPY = {
  auth_failed: { title: 'RCON rejected the password', detail: 'The server is reachable. Check the RCON password in Server settings.' },
  dropped: { title: 'RCON dropped the connection', detail: 'It disconnected while running a command. Recheck once the server is back.' },
  unreachable: { title: "RCON isn't reachable", detail: 'Start the server, then check the RCON host, port and password in Server settings.' },
}

/** The RCON state line and, when RCON can't be used, an alert saying why and where to fix it. */
export function RconStatus({ link }: { link: RconLink }) {
  const badge = !link.configured
    ? { variant: 'warning' as const, label: 'Not set up' }
    : link.checking
      ? { variant: 'outline' as const, label: 'Checking' }
      : link.connected === null
        ? { variant: 'outline' as const, label: 'Unknown' }
        : link.connected
          ? { variant: 'success' as const, label: 'Connected' }
          : { variant: 'error' as const, label: 'Offline' }
  const failure = link.configured && link.connected === false ? FAILURE_COPY[link.failure ?? 'unreachable'] : null

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">RCON</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <Button size="sm" variant="ghost" className="ms-auto" onClick={() => void link.recheck()} disabled={!link.configured || link.checking}>
          {link.checking ? <Spinner /> : <RefreshCw />}
          Recheck
        </Button>
      </div>
      {!link.configured && (
        <Alert variant="warning">
          <AlertTitle>RCON isn't set up</AlertTitle>
          <AlertDescription>Add the RCON host, port and password for this server to send commands and messages.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" render={<Link to="/server-settings" />}>
              Server settings
            </Button>
          </AlertAction>
        </Alert>
      )}
      {failure && (
        <Alert variant="error">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.detail}</AlertDescription>
          {link.failure !== 'dropped' && (
            <AlertAction>
              <Button size="xs" variant="outline" render={<Link to="/server-settings" />}>
                Server settings
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
    </div>
  )
}
