import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle, CheckCircle2, CircleHelp, RefreshCw } from 'lucide-react'
import { debugApi } from '@/lib/api'
import { cn, formatBytes, formatUptime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Meter, MeterIndicator, MeterTrack } from '@/components/ui/meter'
import { Spinner } from '@/components/ui/spinner'
import { CopyPath } from './CopyPath'
import { ReportError, ReportLoading } from './CheckList'
import { getHealthHeadline, type HealthTone } from './healthHeadline'

const TONE: Record<HealthTone, { icon: typeof AlertCircle; className: string }> = {
  checking: { icon: CircleHelp, className: 'text-muted-foreground' },
  healthy: { icon: CheckCircle2, className: 'text-success' },
  servicesDown: { icon: AlertTriangle, className: 'text-warning' },
  issues: { icon: AlertCircle, className: 'text-destructive' },
  unknown: { icon: CircleHelp, className: 'text-muted-foreground' },
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

/** The panel process itself: the services it talks to, its memory and its files. */
export function HealthPanel() {
  const query = useQuery({ queryKey: ['diagnostics', 'health'], queryFn: debugApi.getHealth, refetchInterval: 30_000, retry: false })
  const system = useQuery({ queryKey: ['diagnostics', 'system'], queryFn: debugApi.getSystem, retry: false, staleTime: Infinity })
  const health = query.data

  if (!health) {
    return query.isError ? (
      <ReportError title="Couldn't read the panel's health" error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />
    ) : (
      <ReportLoading label="Checking the panel…" />
    )
  }

  const headline = getHealthHeadline(health)
  const { icon: Icon, className } = TONE[headline.tone]
  const { rcon, server, modChecker } = health.services
  const { heapUsed, heapTotal, heapLimit, rss } = health.memory
  const heapRatio = heapLimit ? heapUsed / heapLimit : null

  return (
    <div className="grid gap-4">
      {query.isError && <ReportError title="The last check failed, so this is old" error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className={cn('size-5', className)} />
            {headline.title}
          </CardTitle>
          <CardDescription>Checked at {new Date(health.timestamp).toLocaleTimeString('en')}. Runs again every 30 seconds.</CardDescription>
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
              {query.isFetching ? <Spinner /> : <RefreshCw />}
              Check again
            </Button>
          </CardAction>
        </CardHeader>
        <CardPanel>
          <ul className="divide-y text-sm">
            <li className="flex items-center gap-3 py-2.5">
              <span className="flex-1 font-medium">RCON</span>
              <span className="truncate text-muted-foreground">{rcon.host || 'Not set up'}</span>
              <Badge variant={rcon.connected ? 'success' : 'error'}>{rcon.connected ? 'Connected' : 'Disconnected'}</Badge>
            </li>
            <li className="flex items-center gap-3 py-2.5">
              <span className="flex-1 font-medium">Game server</span>
              {server.scanFailed && <span className="text-muted-foreground">The process scan failed</span>}
              <Badge variant={server.running === true ? 'success' : server.running === false ? 'secondary' : 'warning'}>
                {server.running === true ? 'Running' : server.running === false ? 'Stopped' : 'Unknown'}
              </Badge>
            </li>
            <li className="flex items-center gap-3 py-2.5">
              <span className="flex-1 font-medium">Mod update checker</span>
              {modChecker.running && modChecker.interval > 0 && <span className="text-muted-foreground">Every {Math.floor(modChecker.interval / 60_000)} min</span>}
              <Badge variant={modChecker.running ? 'success' : 'secondary'}>{modChecker.running ? 'On' : 'Off'}</Badge>
            </li>
          </ul>
        </CardPanel>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Panel process</CardTitle>
            <CardDescription>
              Up {formatUptime(health.uptime)}, since {new Date(Date.now() - health.uptime * 1000).toLocaleString('en')}.
            </CardDescription>
          </CardHeader>
          <CardPanel className="grid gap-4">
            {heapRatio !== null && (
              <Meter value={Math.min(100, Math.round(heapRatio * 100))} aria-label="Heap used of limit">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Heap used of its limit</span>
                  <span className="tabular-nums">{(heapRatio * 100).toFixed(1)}%</span>
                </div>
                <MeterTrack className="h-1.5 rounded-full">
                  <MeterIndicator className={cn('rounded-full', heapRatio >= 0.9 ? 'bg-destructive' : heapRatio >= 0.75 ? 'bg-warning' : 'bg-primary')} />
                </MeterTrack>
              </Meter>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm tabular-nums">
              <Row label="Heap used">{formatBytes(heapUsed)}</Row>
              <Row label="Heap allocated">{formatBytes(heapTotal)}</Row>
              {heapLimit !== undefined && <Row label="Heap limit">{formatBytes(heapLimit)}</Row>}
              <Row label="Resident memory">{formatBytes(rss)}</Row>
              <Row label="Node.js">{system.data?.nodeVersion ?? (system.isError ? 'Unavailable' : '…')}</Row>
              <Row label="Platform">{system.data?.platform ?? (system.isError ? 'Unavailable' : '…')}</Row>
            </dl>
          </CardPanel>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Files</CardTitle>
            <CardDescription>Where the panel keeps its database and logs.</CardDescription>
            <CardAction>
              <Button size="sm" variant="outline" render={<Link to="/settings" search={{ tab: 'paths' }} />}>
                Change
              </Button>
            </CardAction>
          </CardHeader>
          <CardPanel>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <Row label="Database">{system.data ? <CopyPath label="Database path" value={system.data.dbPath} /> : system.isError ? 'Unavailable' : '…'}</Row>
              <Row label="Logs">{system.data ? <CopyPath label="Logs folder" value={system.data.logsPath} /> : system.isError ? 'Unavailable' : '…'}</Row>
            </dl>
          </CardPanel>
        </Card>
      </div>
    </div>
  )
}
