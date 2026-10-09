import { createContext, useContext, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  modsApi,
  panelUpdateApi,
  playersApi,
  serverApi,
  serversApi,
  updateApi,
  type UpdateStatus,
} from '@/lib/api'
import { resolveClientProvider, toClientRunState } from '@/lib/serverStatus'
import { SocketContext } from '@/contexts/SocketContext'
import { panelHealthQueryOptions } from '@/lib/panelHealth'
import { panelQueryKeys } from '@/lib/queryClient'
import { toastManager } from '@/components/ui/toast'

export type ServerRunState = 'unknown' | 'running' | 'stopped' | 'transitioning'

export interface OnlinePlayer {
  name: string
}
const NO_PLAYERS: OnlinePlayer[] = []

const gameUpdateDismissKey = (update: UpdateStatus) =>
  update.installed && update.latest
    ? `updateBannerDismissed:${update.installed.buildId}->${update.latest.buildId}`
    : null

/** Live state the shell shows on every page: servers, run state and signals. */
export function useShellStatus() {
  const queryClient = useQueryClient()
  const socket = useContext(SocketContext)

  const { data: serversData } = useQuery({
    queryKey: panelQueryKeys.servers,
    queryFn: serversApi.getAll,
    retry: false,
    staleTime: 30_000,
  })
  const servers = serversData?.servers ?? null
  const selectedServer = servers?.find((server) => server.isActive) ?? null
  const selectedServerId = selectedServer?.id
  const serversConfirmedEmpty = servers !== null && servers.length === 0
  const provider = resolveClientProvider(selectedServer)

  const { data: panelHealth } = useQuery({ ...panelHealthQueryOptions(), refetchInterval: 15000 })

  const { data: runtimeStatus } = useQuery({
    queryKey: panelQueryKeys.serverStatus,
    queryFn: () => serverApi.getStatus({ retries: 0 }),
    enabled: provider === 'native',
    retry: false,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })
  const { data: composedStatus } = useQuery({
    queryKey: panelQueryKeys.activeServerStatusFor(selectedServer?.id),
    queryFn: () => serversApi.getComposedStatus({ retries: 0 }),
    enabled: provider !== null && provider !== 'native',
    retry: false,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })

  const { data: onlinePlayers } = useQuery({
    queryKey: panelQueryKeys.onlinePlayersFor(selectedServer?.id),
    queryFn: async () => ((await playersApi.getPlayers({ retries: 0 })) as { players?: OnlinePlayer[] }).players ?? [],
    enabled: selectedServer !== null,
    retry: false,
    staleTime: 30_000,
  })
  const players = onlinePlayers ?? NO_PLAYERS

  const [runState, setRunState] = useState<ServerRunState>('unknown')
  const [modUpdates, setModUpdates] = useState(0)
  const [panelUpdate, setPanelUpdate] = useState<{ version: string | null } | null>(null)
  const [gameUpdate, setGameUpdate] = useState<UpdateStatus | null>(null)
  const [gameUpdateDismissed, setGameUpdateDismissed] = useState(false)

  useEffect(() => {
    if (provider === null) {
      setRunState('unknown')
      return
    }
    const status = provider === 'native' ? runtimeStatus : composedStatus
    const lifecycleState = toClientRunState(status?.state)
    if (lifecycleState) {
      setRunState(lifecycleState)
      return
    }
    if (provider === 'native' && typeof runtimeStatus?.running === 'boolean') {
      setRunState(runtimeStatus.running ? 'running' : 'stopped')
      return
    }
    if (composedStatus) {
      const active =
        composedStatus.host.status === 'running' ||
        composedStatus.server.status === 'connected' ||
        composedStatus.gameIntegration.status === 'active'
      const hostUnknown = ['unknown', 'not-applicable'].includes(composedStatus.host.status)
      setRunState(active ? 'running' : hostUnknown ? 'unknown' : 'stopped')
    }
  }, [provider, runtimeStatus, composedStatus])

  useEffect(() => {
    if (!socket) return
    // The server only emits when the list changes, so this keeps the query fresh without polling RCON.
    const onPlayers = (players: unknown) => {
      if (Array.isArray(players)) queryClient.setQueryData(panelQueryKeys.onlinePlayersFor(selectedServer?.id), players)
    }
    const onStatus = (data?: { running?: boolean; isRunning?: boolean; state?: string }) => {
      void queryClient.invalidateQueries({ queryKey: panelQueryKeys.serverStatus })
      void queryClient.invalidateQueries({ queryKey: panelQueryKeys.activeServerStatus })
      const lifecycleState = toClientRunState(data?.state)
      if (lifecycleState) {
        setRunState(lifecycleState)
        return
      }
      if (provider === 'native') {
        const running = typeof data?.running === 'boolean' ? data.running : data?.isRunning
        if (typeof running === 'boolean') setRunState(running ? 'running' : 'stopped')
      }
    }
    const refreshComposed = () => {
      void queryClient.invalidateQueries({ queryKey: panelQueryKeys.activeServerStatus })
    }
    const onServersChanged = () => {
      for (const queryKey of [
        panelQueryKeys.servers,
        panelQueryKeys.activeServer,
        panelQueryKeys.serverStatus,
        panelQueryKeys.activeServerStatus,
        panelQueryKeys.rconStatuses,
      ]) {
        void queryClient.invalidateQueries({ queryKey })
      }
    }
    const onActionResult = (data?: { kind?: 'restart' | 'task'; taskName?: string; success?: boolean; message?: string }) => {
      if (!data) return
      const subject = data.kind === 'restart' ? 'Restart' : `"${String(data.taskName)}"`
      toastManager.add({
        title: `${subject} ${data.success ? 'completed' : 'failed'}`,
        description: data.message,
        type: data.success ? 'success' : 'error',
      })
    }
    const onUpdateAvailable = (data: UpdateStatus) => {
      setGameUpdate(data)
      const key = gameUpdateDismissKey(data)
      setGameUpdateDismissed(!!key && localStorage.getItem(key) === 'true')
    }
    const onUpdateCheck = (data: UpdateStatus) => setGameUpdate(data.updateAvailable ? data : null)

    socket.on('players:update', onPlayers)
    socket.on('server:status', onStatus)
    // Only connection changes. gameIntegration:modStatus fires on every game heartbeat, about once a second.
    socket.on('gameIntegration:status', refreshComposed)
    socket.on('servers:changed', onServersChanged)
    socket.on('scheduler:action_result', onActionResult)
    socket.on('server:updateAvailable', onUpdateAvailable)
    socket.on('server:updateCheck', onUpdateCheck)
    return () => {
      socket.off('players:update', onPlayers)
      socket.off('server:status', onStatus)
      socket.off('gameIntegration:status', refreshComposed)
      socket.off('servers:changed', onServersChanged)
      socket.off('scheduler:action_result', onActionResult)
      socket.off('server:updateAvailable', onUpdateAvailable)
      socket.off('server:updateCheck', onUpdateCheck)
    }
  }, [socket, provider, queryClient, selectedServer?.id])

  useEffect(() => {
    if (!selectedServerId) return
    let cancelled = false
    const refresh = async () => {
      try {
        const data = (await modsApi.getStatus()) as { updatesAvailable?: number } | undefined
        if (!cancelled && typeof data?.updatesAvailable === 'number') setModUpdates(data.updatesAvailable)
      } catch {
        // Mod checks fail while the server isn't running; keep the last count.
      }
    }
    void refresh()
    socket?.on('mods:updates_available', refresh)
    socket?.on('mods:update_detected', refresh)
    return () => {
      cancelled = true
      socket?.off('mods:updates_available', refresh)
      socket?.off('mods:update_detected', refresh)
    }
  }, [socket, selectedServerId])

  const hasServer = Boolean(selectedServer)
  useEffect(() => {
    let cancelled = false
    panelUpdateApi
      .getStatus()
      .then((status) => {
        if (!cancelled) setPanelUpdate(status?.updateAvailable ? { version: status.latestVersion } : null)
      })
      .catch(() => {})
    // Game updates belong to a server; mod and update routes reject requests without one.
    if (hasServer)
      updateApi
        .getStatus()
        .then((status) => {
          if (!cancelled && status.updateAvailable?.updateAvailable) setGameUpdate(status.updateAvailable)
        })
        .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [hasServer])

  const dismissGameUpdate = () => {
    setGameUpdateDismissed(true)
    const key = gameUpdate ? gameUpdateDismissKey(gameUpdate) : null
    if (key) localStorage.setItem(key, 'true')
  }

  return {
    servers,
    selectedServer,
    serversConfirmedEmpty,
    runState,
    players,
    playerCount: players.length,
    modUpdates,
    panelUpdate,
    panelVersion: panelHealth?.version ?? '',
    gameUpdate: gameUpdate?.updateAvailable && !gameUpdateDismissed ? gameUpdate : null,
    dismissGameUpdate,
  }
}

export type ShellStatus = ReturnType<typeof useShellStatus>

export const ShellStatusContext = createContext<ShellStatus | null>(null)

/** The shell's live status for pages inside the app layout. */
export function useShell(): ShellStatus {
  const status = useContext(ShellStatusContext)
  if (!status) throw new Error('useShell must be used inside the app layout')
  return status
}
