import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Container, Loader2, Play, Plus, RefreshCw, RotateCw, Settings2, Square } from 'lucide-react'
import { dockerApi, serverApi, serversApi, updateApi, type DockerContainerStats, type DockerContainerSummary, type ServerInstance, type UpdateStatus } from '@/lib/api'
import { reportClientError, reportClientWarning } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { panelQueryKeys } from '@/lib/queryClient'
import { resolveClientProvider, resolveServerCardRunning, waitForServerState } from '@/lib/serverStatus'
import { selectServer } from '@/lib/serverSelection'
import { SocketContext } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { PageLoading } from '@/components/PageLoading'
import { ServerStatusBadge, type StatusSignal } from '@/components/ServerStatusBadge'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardFooter, CardHeader, CardPanel } from '@/components/ui/card'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { toastManager } from '@/components/ui/toast'

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function resolveDockerCardHostStatus(dockerAvailable: boolean, container: { state: string } | undefined): 'running' | 'stopped' | 'unknown' {
  if (!dockerAvailable || !container) return 'unknown'
  return container.state === 'running' ? 'running' : 'stopped'
}

const findContainer = (containers: DockerContainerSummary[], server: ServerInstance) =>
  server.dockerContainerName ? containers.find((item) => item.name === server.dockerContainerName || item.id === server.dockerContainerName) : undefined

function IconAction({ label, onClick, disabled, pending, children }: { label: string; onClick: () => void; disabled?: boolean; pending?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-sm" variant="ghost" aria-label={label} onClick={onClick} disabled={disabled} />}>{pending ? <Loader2 className="animate-spin" /> : children}</TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  )
}

export default function ServersPage() {
  const confirm = useConfirm()
  const socket = useContext(SocketContext)
  const queryClient = useQueryClient()

  const { data: serversData, error: serversError, isPending, refetch: refetchServers } = useQuery({
    queryKey: panelQueryKeys.servers,
    queryFn: () => serversApi.getAll(),
    retry: false,
    staleTime: 0,
  })
  const servers = serversData?.servers ?? null
  const selectedId = servers?.find((server) => server.isActive)?.id ?? null

  const { data: statusData, refetch: refetchStatuses } = useQuery({
    queryKey: panelQueryKeys.serversStatus,
    queryFn: () => serversApi.getStatus({ retries: 0 }),
    retry: false,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })
  const processStatus = useMemo(
    () => Object.fromEntries((statusData?.servers || []).map((s) => [String(s.id), { running: !!s.running, pid: s.pid, stateUnknown: s.stateUnknown === true }])),
    [statusData],
  )

  const { data: rconData } = useQuery({
    queryKey: panelQueryKeys.rconStatuses,
    queryFn: () => serversApi.getRconStatuses(),
    retry: false,
    staleTime: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
  const rconStatus = useMemo(() => Object.fromEntries((rconData?.servers || []).map((s) => [String(s.id), s.status])), [rconData])

  const { data: dockerData, refetch: refetchDocker } = useQuery({
    queryKey: panelQueryKeys.dockerStatus,
    queryFn: async () => {
      const status = await dockerApi.getStatus()
      if (!status.enabled || !status.available) return { ...status, stats: {} as Record<string, DockerContainerStats> }
      return { ...status, stats: (await dockerApi.getStats()).containers || {} }
    },
    retry: false,
    staleTime: 0,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
  const dockerAvailable = Boolean(dockerData?.enabled && dockerData?.available)
  const containers = dockerData?.containers ?? []
  const dockerStats = dockerData?.stats ?? {}

  const { data: selectedStatus } = useQuery({
    queryKey: panelQueryKeys.activeServerStatusFor(selectedId),
    queryFn: () => serversApi.getComposedStatus({ retries: 0 }),
    enabled: selectedId !== null,
    retry: false,
    staleTime: 0,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })

  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null)
  const [gameVersion, setGameVersion] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    updateApi
      .getStatus()
      .then((status) => {
        if (status.updateAvailable?.updateAvailable) setUpdateInfo(status.updateAvailable)
        if (status.gameVersion) setGameVersion(status.gameVersion)
      })
      .catch((error) => reportClientWarning('Failed to load update status.', error))
  }, [])

  useEffect(() => {
    if (!socket) return
    const onStatus = () => {
      for (const queryKey of [panelQueryKeys.serversStatus, panelQueryKeys.activeServerStatus, panelQueryKeys.rconStatuses]) void queryClient.invalidateQueries({ queryKey })
    }
    const onUpdate = (data: UpdateStatus) => setUpdateInfo(data.updateAvailable ? data : null)
    socket.on('server:status', onStatus)
    socket.on('server:updateAvailable', onUpdate)
    socket.on('server:updateCheck', onUpdate)
    return () => {
      socket.off('server:status', onStatus)
      socket.off('server:updateAvailable', onUpdate)
      socket.off('server:updateCheck', onUpdate)
    }
  }, [socket, queryClient])

  const refreshAll = useCallback(() => Promise.allSettled([refetchServers(), refetchStatuses(), refetchDocker()]), [refetchServers, refetchStatuses, refetchDocker])

  const waitForState = (serverId: string | number, running: boolean) =>
    waitForServerState(
      () => serversApi.getStatus({ retries: 0 }),
      serverId,
      running,
      (status) => {
        queryClient.setQueryData(panelQueryKeys.serversStatus, (previous) => {
          if (!previous || typeof previous !== 'object' || !('servers' in previous) || !Array.isArray(previous.servers)) return previous
          return { ...previous, servers: previous.servers.map((entry) => (String(entry.id) === String(status.id) ? { ...entry, running: status.running, pid: status.pid } : entry)) }
        })
      },
    )

  const start = async (server: ServerInstance) => {
    setPending(`start-${server.id}`)
    try {
      await serverApi.start(String(server.id))
      const confirmed = await waitForState(server.id, true)
      toastManager.add(confirmed ? { title: `${server.name} started`, type: 'success' } : { title: 'Start requested', description: 'Still waiting for the process to appear.' })
      await refreshAll()
    } catch (error) {
      toastManager.add({ title: "The server didn't start", description: getUserErrorMessage(error, 'Unknown error.'), type: 'error' })
    } finally {
      setPending(null)
    }
  }

  const stop = async (server: ServerInstance) => {
    const ok = await confirm({ title: `Stop ${server.name}?`, description: 'Everyone online is disconnected. You can start it again any time.', confirmLabel: 'Stop server', destructive: false })
    if (!ok) return
    setPending(`stop-${server.id}`)
    try {
      await serverApi.stop(String(server.id))
      const confirmed = await waitForState(server.id, false)
      toastManager.add(confirmed ? { title: `${server.name} stopped`, type: 'success' } : { title: 'Stop requested', description: 'Still waiting for the process to stop.' })
      await refreshAll()
    } catch (error) {
      toastManager.add({ title: "The server didn't stop", description: getUserErrorMessage(error, 'Unknown error.'), type: 'error' })
    } finally {
      setPending(null)
    }
  }

  const dockerAction = async (server: ServerInstance, container: DockerContainerSummary, action: 'start' | 'stop' | 'restart') => {
    if (action !== 'start') {
      const ok = await confirm(
        action === 'stop'
          ? {
              title: `Stop the ${container.name} container?`,
              description: "The panel saves through RCON first, but Docker stops the container itself and force-kills it if it doesn't exit in time. That can end ungracefully, unlike the regular Stop.",
              confirmLabel: 'Stop container',
            }
          : { title: `Restart the ${container.name} container?`, description: 'Everyone online is disconnected while the container restarts.', confirmLabel: 'Restart container', destructive: false },
      )
      if (!ok) return
    }
    setPending(`${action}-${container.id}`)
    try {
      const result = await dockerApi.runAction(server.dockerContainerName || container.id, action, server.id)
      if (!result.success) throw new Error(result.error || `Failed to ${action} the container.`)
      toastManager.add({ title: `Container ${action} requested`, description: container.name, type: 'success' })
      await refetchDocker()
    } catch (error) {
      toastManager.add({ title: `Container ${action} failed`, description: getUserErrorMessage(error, 'The Docker action failed.'), type: 'error' })
    } finally {
      setPending(null)
    }
  }

  const select = async (server: ServerInstance) => {
    setPending(`select-${server.id}`)
    try {
      await selectServer(server.id)
    } catch (error) {
      reportClientError('Failed to select server.', error)
      toastManager.add({ title: "Couldn't switch servers", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
      setPending(null)
    }
  }

  const addButton = (
    <Button render={<Link to="/servers/new" />}>
      <Plus />
      Add a server
    </Button>
  )

  if (isPending) return <PageLoading />

  return (
    <div className="grid gap-6">
      <PageHeader title="Servers" description="Every server this panel manages." actions={servers && servers.length > 0 ? addButton : undefined} />

      {serversError && (
        <Alert variant="error">
          <AlertTitle>Servers couldn't be loaded</AlertTitle>
          <AlertDescription>{getUserErrorMessage(serversError, 'The backend may be unreachable.')}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void refetchServers()}>
              <RefreshCw />
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {servers && servers.length === 0 && (
        <EmptyState
          type="serverOffline"
          title="No servers yet"
          description="Install a new server, set up files you've downloaded, or connect one that already runs. Overview, players, mods and backups come online once you have one."
          action={{ label: 'Add a server', to: '/servers/new', variant: 'default' }}
        />
      )}

      {servers && servers.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {servers.map((server) => {
            const selected = server.isActive
            const container = dockerAvailable ? findContainer(containers, server) : undefined
            const stats = container && (dockerStats[container.id] || dockerStats[container.name])
            const provider = resolveClientProvider(server)
            let host: StatusSignal | undefined
            let rcon: StatusSignal | undefined
            if (selected && selectedStatus) {
              host = selectedStatus.host
              rcon = selectedStatus.server
            } else {
              if (provider === 'docker-local') {
                const dockerHost = resolveDockerCardHostStatus(dockerAvailable, findContainer(containers, server))
                host = dockerHost === 'unknown' ? { status: 'unknown', label: 'Container', detail: 'Unavailable' } : { status: dockerHost, label: 'Container' }
              } else if (processStatus[String(server.id)]) {
                host = { status: processStatus[String(server.id)].running ? 'running' : 'stopped', label: 'Process' }
              }
              const r = rconStatus[String(server.id)]
              if (r) rcon = r === 'connected' ? { status: 'connected', label: 'RCON' } : r === 'unconfigured' ? { status: 'unknown', label: 'RCON', detail: 'Not configured' } : { status: 'disconnected', label: 'RCON' }
            }
            const running = resolveServerCardRunning(server, processStatus[String(server.id)], selected ? (selectedStatus ?? null) : null)
            const hasUpdate = selected && updateInfo?.updateAvailable
            const busy = pending !== null

            return (
              <Card key={server.id} className={selected ? 'border-foreground/24' : undefined}>
                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                  <div className="grid min-w-0 gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-base font-semibold">{server.name}</span>
                      {selected && <Badge variant="secondary">Selected</Badge>}
                      {hasUpdate && <Badge variant="warning">Update available</Badge>}
                    </div>
                    <span className="font-mono text-sm text-muted-foreground">{server.serverName}</span>
                    <ServerStatusBadge compact host={host} server={rcon} gameIntegration={selected ? selectedStatus?.gameIntegration : undefined} />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    render={<Link to="/server-settings" search={{ server: String(server.id) }} />}
                  >
                    <Settings2 />
                    Settings
                  </Button>
                </CardHeader>
                <CardPanel className="grid gap-4">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                    {[
                      ['RCON', `${server.rconHost}:${server.rconPort}`],
                      ['Game port', String(server.serverPort)],
                      ['Memory', `${server.minMemory}–${server.maxMemory} GB`],
                      ['Build', selected && updateInfo ? `${updateInfo.installed.buildId}${updateInfo.updateAvailable ? ` → ${updateInfo.latest.buildId}` : ''}` : server.branch || '—'],
                    ].map(([label, value]) => (
                      <div key={label} className="grid min-w-0 gap-0.5">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="truncate font-mono tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {server.installPath && (
                    <p className="truncate font-mono text-sm text-muted-foreground" title={server.installPath}>
                      {server.installPath}
                      {selected && gameVersion ? ` · v${gameVersion}` : ''}
                    </p>
                  )}
                  {container && (
                    <div className="grid gap-2 rounded-xl border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2 text-sm">
                          <Container className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium">{container.name}</span>
                          <span className={container.state === 'running' ? 'text-muted-foreground' : 'text-destructive-foreground'}>{container.state}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <IconAction label="Start container" onClick={() => void dockerAction(server, container, 'start')} disabled={busy || container.state === 'running'} pending={pending === `start-${container.id}`}>
                            <Play />
                          </IconAction>
                          <IconAction label="Stop container" onClick={() => void dockerAction(server, container, 'stop')} disabled={busy || container.state !== 'running'} pending={pending === `stop-${container.id}`}>
                            <Square />
                          </IconAction>
                          <IconAction label="Restart container" onClick={() => void dockerAction(server, container, 'restart')} disabled={busy} pending={pending === `restart-${container.id}`}>
                            <RotateCw />
                          </IconAction>
                        </span>
                      </div>
                      {stats && (
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-4">
                          <div>CPU {stats.cpuPercent}%</div>
                          <div>
                            RAM {formatBytes(stats.memoryUsed)} ({stats.memoryPercent}%)
                          </div>
                          <div>Net {formatBytes(stats.networkRx)} in</div>
                          <div>Disk {formatBytes(stats.diskWrite)} written</div>
                        </dl>
                      )}
                    </div>
                  )}
                </CardPanel>
                <CardFooter className="flex flex-wrap gap-2">
                  {!container &&
                    (running === null ? (
                      <Button size="sm" variant="outline" disabled>
                        <Loader2 className="animate-spin" />
                        Checking…
                      </Button>
                    ) : running ? (
                      <Button size="sm" variant="outline" onClick={() => void stop(server)} disabled={busy}>
                        {pending === `stop-${server.id}` ? <Loader2 className="animate-spin" /> : <Square />}
                        Stop
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => void start(server)} disabled={busy}>
                        {pending === `start-${server.id}` ? <Loader2 className="animate-spin" /> : <Play />}
                        Start
                      </Button>
                    ))}
                  {hasUpdate && (
                    <Button size="sm" variant="outline" render={<Link to="/server-settings" />}>
                      <RefreshCw />
                      Update
                    </Button>
                  )}
                  {selected ? (
                    <Button size="sm" variant="ghost" className="ms-auto" render={<Link to="/" />}>
                      Open Overview
                      <ArrowRight />
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" className="ms-auto" onClick={() => void select(server)} disabled={busy}>
                      {pending === `select-${server.id}` && <Loader2 className="animate-spin" />}
                      Switch to this server
                      <ArrowRight />
                    </Button>
                  )}
                </CardFooter>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
