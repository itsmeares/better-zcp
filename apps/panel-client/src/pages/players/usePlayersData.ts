import { useQuery, useQueryClient } from '@tanstack/react-query'
import { gameIntegrationApi, playersApi, type GameIntegrationPlayerDetails } from '@/lib/api'
import { panelQueryKeys } from '@/lib/queryClient'
import { useShell } from '@/components/shell/useShellStatus'
import type { PlayerPowers } from '@/components/players/PlayerActions'

export interface PlayerStat {
  player_name: string
  total_playtime_seconds: number
  session_count: number
  first_seen: string
  last_seen: string
  deaths?: number
  sessions?: Array<{ start: string; end: string; duration_seconds: number }>
}

export interface WhitelistAccount {
  id: number
  username: string
  lastConnection: string | null
  role: string
  steamId: string | null
  displayName: string | null
}

export interface SteamBan {
  steamId: string
  banned_at: string
  reason?: string
}

export interface Whitelist {
  available: boolean
  reason?: string
  accounts: WhitelistAccount[]
  allowedSteamIds: string[]
}

const live = { retry: false, refetchInterval: 15_000, refetchIntervalInBackground: false } as const

/** Everything the Players page reads, keyed by server so a switch never shows another server's data. */
export function usePlayersData() {
  const { selectedServer, players } = useShell()
  const queryClient = useQueryClient()
  const id = selectedServer?.id ?? 'none'

  const integration = useQuery({
    queryKey: ['game-integration', 'status', id],
    queryFn: gameIntegrationApi.getStatus,
    retry: false,
    refetchInterval: 30_000,
  })
  const integrationConnected = Boolean(integration.data?.modConnected && integration.data.isRunning)

  const details = useQuery({
    queryKey: ['game-integration', 'players', id],
    queryFn: async () => {
      const result = await gameIntegrationApi.getAllPlayerDetails()
      return result.success ? (result.data?.players ?? []) : []
    },
    enabled: integrationConnected,
    ...live,
  })
  const stats = useQuery({
    queryKey: ['players', 'stats', id],
    queryFn: async () => {
      const data = (await playersApi.getStats()) as { stats?: Array<PlayerStat & { playerName?: string }> }
      const byName: Record<string, PlayerStat> = {}
      for (const stat of data.stats ?? []) {
        const name = stat.player_name || stat.playerName
        if (name) byName[name] = { ...stat, player_name: name }
      }
      return byName
    },
    ...live,
  })
  const bans = useQuery({
    queryKey: ['players', 'steam-bans', id],
    queryFn: async () => ((await playersApi.getSteamIdBans()) as { bans?: SteamBan[] }).bans ?? [],
    retry: false,
  })
  const whitelist = useQuery({
    queryKey: ['players', 'whitelist', id],
    queryFn: async (): Promise<Whitelist> => {
      const result = await playersApi.getWhitelist()
      return {
        available: result.available !== false,
        reason: (result as { reason?: string }).reason,
        accounts: (result.accounts ?? []) as WhitelistAccount[],
        allowedSteamIds: result.allowedSteamIds ?? [],
      }
    },
    retry: false,
  })

  const byName = new Map<string, GameIntegrationPlayerDetails>((details.data ?? []).map((player) => [player.username, player]))
  const powersOf = (name: string): PlayerPowers | undefined => {
    const player = byName.get(name)
    return player ? { godMode: player.godMod, invisible: player.invisible, noclip: player.noclip } : undefined
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: panelQueryKeys.onlinePlayersFor(selectedServer?.id) })
    void queryClient.invalidateQueries({ queryKey: ['players'] })
    void queryClient.invalidateQueries({ queryKey: ['game-integration'] })
  }

  return {
    online: players,
    integrationConnected,
    details: byName,
    powersOf,
    stats,
    bans,
    whitelist,
    refresh,
  }
}

export type PlayersData = ReturnType<typeof usePlayersData>

export function formatPlaytime(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export const sanitizeSteamId = (value: string) => value.replace(/\D/g, '').slice(0, 17)
