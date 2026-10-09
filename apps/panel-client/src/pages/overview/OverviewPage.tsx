import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, CircleAlert, Info, TriangleAlert } from 'lucide-react'
import { backupApi, gameIntegrationApi, playersApi, schedulerApi, serverApi, serversApi } from '@/lib/api'
import type { LifecycleState } from '@/lib/serverStatus'
import { resolveClientProvider } from '@/lib/serverStatus'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { panelQueryKeys } from '@/lib/queryClient'
import { cn } from '@/lib/utils'
import { useSocket } from '@/contexts/SocketContext'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'
import { EmptyState } from '@/components/EmptyState'
import { useServerActions } from '@/components/server/useServerActions'
import { useShell } from '@/components/shell/useShellStatus'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Frame, FramePanel } from '@/components/ui/frame'
import { Meter, MeterIndicator, MeterTrack } from '@/components/ui/meter'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { OverviewHeader, type HeaderFacts } from './OverviewHeader'
import { usePerformance, type PerfRange } from './usePerformance'
import type { PerfMetric } from './PerformanceChart'

const PerformanceChart = lazy(() => import('./PerformanceChart'))

interface ServerStatus {
  running: boolean
  state?: LifecycleState
  uptime: number
  serverPathConfigured: boolean
  publicIp?: string
  localIp?: string
  port?: number
  rcon: { host: string; port: number; connected: boolean }
}

interface ActivityEntry {
  id: number
  player_name: string
  action: string
  logged_at: string
}

function since(iso: string, now: number) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

function until(iso: string, now: number) {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 0) return null
  if (minutes < 1) return 'any moment'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `in ${hours}h ${minutes % 60}m` : `in ${hours}h`
  return `in ${Math.floor(hours / 24)}d`
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const ACTIVITY: Record<string, { verb: string; label: string; variant: 'success' | 'secondary' | 'warning' | 'error' }> = {
  connect: { verb: 'joined', label: 'Joined', variant: 'success' },
  disconnect: { verb: 'left', label: 'Left', variant: 'secondary' },
  death: { verb: 'died', label: 'Died', variant: 'warning' },
  pvp_kill: { verb: 'killed a player', label: 'PvP', variant: 'warning' },
  kick: { verb: 'was kicked', label: 'Kicked', variant: 'warning' },
  ban: { verb: 'was banned', label: 'Banned', variant: 'error' },
}

/** CPU and memory are worth a look at 70% and a problem at 90%. A disk fills slower, so it waits longer. */
const LOAD_LIMITS = { warn: 0.7, bad: 0.9 }
const DISK_LIMITS = { warn: 0.9, bad: 0.95 }

function Stat({
  label,
  value,
  detail,
  ratio,
  limits = LOAD_LIMITS,
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  ratio?: number | null
  limits?: typeof LOAD_LIMITS
}) {
  const tone = ratio == null || ratio < limits.warn ? 'bg-primary' : ratio < limits.bad ? 'bg-warning' : 'bg-destructive'
  return (
    <Card className="gap-2 p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="truncate text-2xl font-semibold tabular-nums">{value}</span>
      {ratio !== undefined && (
        <Meter value={ratio == null ? 0 : Math.min(100, Math.round(ratio * 100))} aria-label={label}>
          <MeterTrack className="h-1.5 rounded-full">
            <MeterIndicator className={cn('rounded-full', tone)} />
          </MeterTrack>
        </Meter>
      )}
      {detail && <span className="truncate text-sm text-muted-foreground">{detail}</span>}
    </Card>
  )
}

type Tone = 'error' | 'warning' | 'info'
interface AttentionItem {
  id: string
  tone: Tone
  title: string
  detail?: string
  action?: ReactNode
}
const TONE_ICON: Record<Tone, ReactNode> = {
  error: <CircleAlert className="size-4 text-destructive-foreground" />,
  warning: <TriangleAlert className="size-4 text-warning-foreground" />,
  info: <Info className="size-4 text-info-foreground" />,
}

function NeedsAttention({ items, updated }: { items: AttentionItem[]; updated: string }) {
  if (items.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4 text-success-foreground" />
        Nothing needs attention.
        <span className="ms-auto">{updated}</span>
      </p>
    )
  }
  return (
    <Frame>
      <div className="flex items-center gap-2 px-4 py-2.5 text-sm">
        <span className="font-semibold">Needs attention</span>
        <Badge variant="secondary">{items.length}</Badge>
        <span className="ms-auto text-muted-foreground">{updated}</span>
      </div>
      <FramePanel className="divide-y p-0">
        {items.map((item) => (
          <div key={item.id} role={item.tone === 'error' ? 'alert' : undefined} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <span className="shrink-0">{TONE_ICON[item.tone]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{item.title}</p>
              {item.detail && <p className="text-sm text-muted-foreground">{item.detail}</p>}
            </div>
            {item.action}
          </div>
        ))}
      </FramePanel>
    </Frame>
  )
}

export default function OverviewPage() {
  const { selectedServer, serversConfirmedEmpty, runState, players, modUpdates, panelUpdate } = useShell()
  const actions = useServerActions()
  const socket = useSocket()
  const queryClient = useQueryClient()
  const [range, setRange] = useState<PerfRange>('6h')
  const [metric, setMetric] = useState<PerfMetric>('cpu')
  const [now, setNow] = useState(() => Date.now())
  const serverId = selectedServer?.id

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(timer)
  }, [])

  const live = { retry: false, staleTime: 0, refetchInterval: 15_000, refetchIntervalInBackground: false } as const
  const statusQuery = useQuery({ queryKey: panelQueryKeys.serverStatus, queryFn: () => serverApi.getStatus({ retries: 0 }), enabled: !!selectedServer, ...live })
  const composedQuery = useQuery({
    queryKey: panelQueryKeys.activeServerStatusFor(serverId),
    queryFn: () => serversApi.getComposedStatus({ retries: 0 }),
    enabled: !!selectedServer,
    ...live,
  })
  const integrationQuery = useQuery({
    queryKey: ['game-integration', 'status', serverId ?? 'none'],
    queryFn: gameIntegrationApi.getStatus,
    enabled: !!selectedServer,
    retry: false,
    refetchInterval: 30_000,
  })
  const integration = integrationQuery.data ?? null
  const worldQuery = useQuery({
    queryKey: ['game-integration', 'world', serverId ?? 'none'],
    queryFn: gameIntegrationApi.getWorldStats,
    enabled: !!integration?.modConnected,
    retry: false,
    refetchInterval: 30_000,
  })
  const activityQuery = useQuery({
    queryKey: ['players', 'activity', serverId ?? 'none'],
    queryFn: async () => ((await playersApi.getActivityLogs(undefined, 12)) as { logs?: ActivityEntry[] }).logs ?? [],
    enabled: !!selectedServer,
    ...live,
  })
  const panelInfoQuery = useQuery({ queryKey: ['panel', 'info'], queryFn: serverApi.getPanelInfo, retry: false, staleTime: Infinity })
  const backupQuery = useQuery({ queryKey: panelQueryKeys.backupStatus, queryFn: backupApi.getStatus, enabled: !!selectedServer, retry: false, refetchInterval: 60_000 })
  const scheduleQuery = useQuery({ queryKey: ['scheduler', 'status', serverId ?? 'none'], queryFn: schedulerApi.getStatus, enabled: !!selectedServer, retry: false, refetchInterval: 60_000 })
  const errorsQuery = useQuery({ queryKey: ['console', 'error-count', serverId ?? 'none'], queryFn: serverApi.getConsoleErrorCount, enabled: !!selectedServer, retry: false, refetchInterval: 60_000 })
  const perfQuery = usePerformance(serverId, range)

  useEffect(() => {
    if (!socket) return
    const refreshIntegration = () => void queryClient.invalidateQueries({ queryKey: ['game-integration'] })
    socket.on('gameIntegration:status', refreshIntegration)
    return () => {
      socket.off('gameIntegration:status', refreshIntegration)
    }
  }, [socket, queryClient])

  const refresh = () => {
    void statusQuery.refetch()
    void composedQuery.refetch()
  }
  usePageShortcut('r', refresh)

  if (serversConfirmedEmpty) {
    return (
      <EmptyState
        type="serverOffline"
        title="Add your first server"
        description="Install a new Project Zomboid server, set one up from files you already have, or connect to one that's running."
        action={{ label: 'Add a server', to: '/servers/new', variant: 'default' }}
      />
    )
  }

  const status = (statusQuery.data ?? null) as ServerStatus | null
  const composed = composedQuery.data ?? null
  const online = runState === 'running' || runState === 'transitioning'
  const rconConnected = composed ? composed.server.status === 'connected' : Boolean(status?.rcon?.connected)
  const points = perfQuery.data ?? []
  const latest = points.at(-1)
  const maxMemoryGB = selectedServer?.maxMemory ?? null
  const hostMemRatio = latest?.hostMemUsedGB != null && latest.hostMemTotalGB ? latest.hostMemUsedGB / latest.hostMemTotalGB : null
  const diskRatio = latest?.diskUsedGB != null && latest.diskTotalGB ? latest.diskUsedGB / latest.diskTotalGB : null
  const swapInUse = latest?.swapUsedGB != null && latest.swapTotalGB ? latest.swapUsedGB : null
  const peakPlayers = points.reduce((peak, point) => Math.max(peak, point.players), 0)
  const backups = backupQuery.data
  const nextRun = scheduleQuery.data?.nextRun
  const nextRunEta = nextRun ? until(nextRun.at, now) : null
  const errorCount = errorsQuery.data?.exists ? errorsQuery.data.count : null
  const lastUpdate = Math.max(statusQuery.dataUpdatedAt, composedQuery.dataUpdatedAt)
  const ago = (iso: string) => {
    const elapsed = since(iso, now)
    return elapsed === 'just now' ? elapsed : `${elapsed} ago`
  }
  const updated = lastUpdate ? `Updated ${ago(new Date(lastUpdate).toISOString())}` : ''

  const joinedAt = new Map<string, string>()
  for (const entry of activityQuery.data ?? []) {
    if (entry.action === 'connect' && !joinedAt.has(entry.player_name)) joinedAt.set(entry.player_name, entry.logged_at)
  }

  const linkButton = (label: string, to: string, search?: Record<string, string>) => (
    <Button size="sm" variant="outline" render={<Link to={to} search={search} />}>
      {label}
    </Button>
  )
  const actionButton = (label: string, onClick: () => void) => (
    <Button size="sm" variant="outline" onClick={onClick} disabled={actions.busy !== null}>
      {label}
    </Button>
  )

  const attention: AttentionItem[] = []
  if (statusQuery.isError) {
    attention.push({
      id: 'unreachable',
      tone: 'error',
      title: "The panel can't read this server's status",
      detail: getUserErrorMessage(statusQuery.error, 'The status request failed.'),
      action: actionButton('Retry', refresh),
    })
  }
  if (resolveClientProvider(selectedServer) === 'native' && status && !status.serverPathConfigured) {
    attention.push({
      id: 'no-path',
      tone: 'warning',
      title: "The install folder isn't set",
      detail: 'Starting and stopping need to know where the server is installed.',
      action: linkButton('Server settings', '/server-settings'),
    })
  }
  if (runState === 'unknown' && selectedServer && !statusQuery.isError) {
    attention.push({ id: 'unknown', tone: 'warning', title: 'Server status unknown', detail: "The panel can't tell whether the game is running." })
  }
  if (online && !rconConnected) {
    attention.push({
      id: 'rcon',
      tone: 'warning',
      title: "RCON isn't connected",
      detail: 'Saving, kicking, messages and most commands need RCON.',
      action: actionButton('Connect RCON', () => void actions.run({ kind: 'connect-rcon' })),
    })
  }
  if (hostMemRatio != null && hostMemRatio >= 0.9) {
    attention.push({ id: 'host-memory', tone: 'error', title: `Host memory at ${Math.round(hostMemRatio * 100)}%`, detail: 'The server may slow down or crash if the host runs out.' })
  }
  if (latest?.cpu != null && latest.cpu >= 90) {
    attention.push({ id: 'cpu', tone: 'warning', title: `Host CPU at ${latest.cpu}%` })
  }
  if (online && integration?.configured && !integration.modConnected) {
    attention.push({
      id: 'integration',
      tone: 'warning',
      title: "Game integration isn't connected",
      detail: 'The live map and player details need it.',
      action: linkButton('Server settings', '/server-settings'),
    })
  }
  if (modUpdates > 0) {
    attention.push({
      id: 'mods',
      tone: 'warning',
      title: plural(modUpdates, 'mod update'),
      detail: 'Players need a restart to get them.',
      action: linkButton('Review mods', '/mods'),
    })
  }
  if (backups && backups.backupCount === 0) {
    attention.push({
      id: 'backups',
      tone: 'warning',
      title: 'No backups yet',
      detail: "Without one there's no way back if the save breaks.",
      action: actionButton('Create backup', () => void actions.run({ kind: 'backup' })),
    })
  }
  if (errorCount != null && errorCount >= 50) {
    attention.push({
      id: 'errors',
      tone: 'warning',
      title: `${errorCount} errors in the console log`,
      detail: errorsQuery.data?.sinceStart ? 'Since the server started.' : undefined,
      action: linkButton('Open console', '/console'),
    })
  }
  if (panelUpdate) {
    attention.push({
      id: 'panel-update',
      tone: 'info',
      title: panelUpdate.version ? `Better ZCP ${panelUpdate.version} is available` : 'A Better ZCP update is available',
      action: linkButton('View update', '/settings', { tab: 'updates' }),
    })
  }

  const address = (host?: string) => (host ? `${host}${status?.port ? `:${status.port}` : ''}` : null)
  const panelInfo = panelInfoQuery.data
  const facts: HeaderFacts = {
    name: selectedServer?.name ?? 'Server',
    runState,
    rconConnected,
    uptime: status?.uptime ?? null,
    map: worldQuery.data?.success ? (worldQuery.data.data?.map ?? null) : null,
    lanAddress: address(status?.localIp),
    publicAddress: address(status?.publicIp),
    panelAddress: panelInfo ? { label: `${panelInfo.localIp}:${panelInfo.port}`, url: panelInfo.url } : null,
    nextRun: nextRun && nextRunEta ? { label: nextRun.label, eta: nextRunEta } : null,
    lastBackup: backups?.lastBackup ? `Backup ${ago(backups.lastBackup.created)}` : null,
  }

  return (
    <div className="grid gap-6 pb-12">
      <OverviewHeader facts={facts} actions={actions} onRefresh={refresh} />

      <NeedsAttention items={attention} updated={updated} />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Server stats">
        <Stat
          label="Players"
          value={online ? players.length : '–'}
          detail={online ? (peakPlayers > 0 ? `Peak ${peakPlayers} in the last ${range}` : 'Nobody online') : 'Server stopped'}
        />
        <Stat
          label="Host CPU"
          value={latest?.cpu != null ? `${latest.cpu}%` : '–'}
          ratio={latest?.cpu != null ? latest.cpu / 100 : null}
          detail={swapInUse != null ? `Swap ${swapInUse} of ${latest?.swapTotalGB} GB` : undefined}
        />
        <Stat
          label="Server memory"
          value={
            online && latest?.pzMemGB != null ? (
              <>
                {latest.pzMemGB}
                {maxMemoryGB ? <span className="text-base font-normal text-muted-foreground"> / {maxMemoryGB} GB</span> : ' GB'}
              </>
            ) : (
              '–'
            )
          }
          ratio={online && latest?.pzMemGB != null && maxMemoryGB ? latest.pzMemGB / maxMemoryGB : null}
          detail={latest?.hostMemUsedGB != null ? `Host ${latest.hostMemUsedGB} of ${latest.hostMemTotalGB} GB` : undefined}
        />
        <Stat
          label="Disk"
          value={
            latest?.diskUsedGB != null ? (
              <>
                {Math.round(latest.diskUsedGB)}
                <span className="text-base font-normal text-muted-foreground"> / {Math.round(latest.diskTotalGB ?? 0)} GB</span>
              </>
            ) : (
              '–'
            )
          }
          ratio={diskRatio}
          limits={DISK_LIMITS}
          detail={latest?.diskUsedGB != null && latest.diskTotalGB ? `${Math.round(latest.diskTotalGB - latest.diskUsedGB)} GB free` : undefined}
        />
      </section>

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Performance</CardTitle>
            <CardDescription>
              <Tabs value={metric} onValueChange={(value) => setMetric(value as PerfMetric)}>
                <TabsList variant="underline" className="-ms-1">
                  <TabsTab value="cpu">CPU</TabsTab>
                  <TabsTab value="memory">Memory</TabsTab>
                  <TabsTab value="players">Players</TabsTab>
                </TabsList>
              </Tabs>
            </CardDescription>
            <CardAction>
              <Tabs value={range} onValueChange={(value) => setRange(value as PerfRange)}>
                <TabsList>
                  <TabsTab value="1h">1h</TabsTab>
                  <TabsTab value="6h">6h</TabsTab>
                  <TabsTab value="24h">24h</TabsTab>
                </TabsList>
              </Tabs>
            </CardAction>
          </CardHeader>
          <CardPanel>
            {perfQuery.isPending ? (
              <Skeleton className="h-[200px] w-full" />
            ) : points.length < 2 ? (
              <p className="grid h-[200px] place-items-center text-sm text-muted-foreground">
                The panel samples once a minute. A chart appears after two samples.
              </p>
            ) : (
              <Suspense fallback={<Skeleton className="h-[200px] w-full" />}>
                <PerformanceChart points={points} metric={metric} max={metric === 'memory' && maxMemoryGB ? maxMemoryGB : undefined} />
              </Suspense>
            )}
          </CardPanel>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Online now</CardTitle>
            <CardDescription>{online ? plural(players.length, 'player') : 'Server stopped'}</CardDescription>
            <CardAction>
              <Button size="sm" variant="ghost" render={<Link to="/players" />}>
                View all
              </Button>
            </CardAction>
          </CardHeader>
          <CardPanel className="px-3">
            {online && players.length > 0 ? (
              <ul className="grid">
                {players.slice(0, 8).map((player) => {
                  const joined = joinedAt.get(player.name)
                  return (
                    <li key={player.name}>
                      <Link
                        to="/players"
                        search={{ player: player.name }}
                        className="flex h-9 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-accent"
                      >
                        <Avatar className="size-6 text-xs">
                          <AvatarFallback>{player.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
                          {player.name}
                        </span>
                        {joined && <span className="text-muted-foreground tabular-nums">{since(joined, now)}</span>}
                      </Link>
                    </li>
                  )
                })}
                {players.length > 8 && <li className="px-2 pt-1 text-sm text-muted-foreground">and {players.length - 8} more</li>}
              </ul>
            ) : (
              <p className="px-2 pb-2 text-sm text-muted-foreground">{online ? 'Nobody is playing right now.' : 'Start the server to see who joins.'}</p>
            )}
          </CardPanel>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
          <CardDescription>Joins, departures, deaths and moderation.</CardDescription>
          <CardAction>
            <Button size="sm" variant="ghost" render={<Link to="/diagnostics" search={{ tab: 'activity' }} />}>
              Open log
            </Button>
          </CardAction>
        </CardHeader>
        <CardPanel className="px-0 pb-2">
          {(activityQuery.data ?? []).length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">No player activity yet.</p>
          ) : (
            <Table>
              <TableBody>
                {(activityQuery.data ?? []).map((entry) => {
                  const kind = ACTIVITY[entry.action] ?? { verb: entry.action.replace(/_/g, ' '), label: 'Event', variant: 'secondary' as const }
                  return (
                    <TableRow key={entry.id}>
                      <TableCell className="w-20 ps-6 font-mono text-muted-foreground tabular-nums">
                        {new Date(entry.logged_at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
                      </TableCell>
                      <TableCell>
                        <span className="font-medium" dir="auto">
                          {entry.player_name}
                        </span>{' '}
                        <span className="text-muted-foreground">{kind.verb}</span>
                      </TableCell>
                      <TableCell className="pe-6 text-end">
                        <Badge variant={kind.variant}>{kind.label}</Badge>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardPanel>
      </Card>
    </div>
  )
}

