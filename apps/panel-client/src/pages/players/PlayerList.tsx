import { useState } from 'react'
import { Eye, Ghost, Heart, Layers, Plus, Search, Skull, Trash2, UserMinus } from 'lucide-react'
import { playersApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/contexts/ConfirmContext'
import { EmptyState } from '@/components/EmptyState'
import { usePlayerAction } from '@/components/players/PlayerActions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { formatPlaytime, sanitizeSteamId, type PlayersData } from './usePlayersData'

export type ListTab = 'online' | 'seen' | 'banned' | 'whitelist'

const day = (iso: string) => new Date(iso).toLocaleDateString('en')

function Row({ selected, onClick, children, title }: { selected?: boolean; onClick?: () => void; children: React.ReactNode; title?: string }) {
  const className = cn('flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-start text-sm', onClick && 'hover:bg-accent', selected && 'bg-accent')
  return onClick ? (
    <button type="button" className={className} onClick={onClick} title={title} aria-pressed={selected}>
      {children}
    </button>
  ) : (
    <div className={className}>{children}</div>
  )
}

/** The roster card: who is online, who has played, Steam ID bans and the whitelist. */
export function PlayerList({
  data,
  tab,
  onTabChange,
  selected,
  onSelect,
}: {
  data: PlayersData
  tab: ListTab
  onTabChange: (tab: ListTab) => void
  selected: string
  onSelect: (name: string) => void
}) {
  const confirm = useConfirm()
  const { busy, run } = usePlayerAction(data.refresh)
  const [search, setSearch] = useState('')
  const [steamIdInput, setSteamIdInput] = useState('')
  const query = search.trim().toLowerCase()
  const matches = (...values: Array<string | null | undefined>) => !query || values.some((value) => value?.toLowerCase().includes(query))

  const onlineNames = new Set(data.online.map((player) => player.name.toLowerCase()))
  const stats = data.stats.data ?? {}
  const seen = Object.values(stats)
    .filter((stat) => !onlineNames.has(stat.player_name.toLowerCase()))
    .sort((a, b) => Date.parse(b.last_seen || '0') - Date.parse(a.last_seen || '0'))
  const bans = data.bans.data ?? []
  const whitelist = data.whitelist.data

  const unbanSteamId = async (steamId: string) => {
    const confirmed = await confirm({ title: `Unban ${steamId}?`, description: 'That Steam account can join again.', confirmLabel: 'Unban' })
    if (confirmed) await run(`unban:${steamId}`, `Unbanned ${steamId}`, () => playersApi.unbanSteamId(steamId))
  }

  const counts: Record<ListTab, number> = {
    online: data.online.length,
    seen: seen.length,
    banned: bans.length,
    whitelist: whitelist?.accounts.length ?? 0,
  }

  return (
    <Card className="gap-3 p-3">
      <Tabs value={tab} onValueChange={(value) => onTabChange(value as ListTab)}>
        <TabsList className="w-full">
          {(['online', 'seen', 'banned', 'whitelist'] as const).map((key) => (
            <TabsTab key={key} value={key} className="gap-1.5">
              {{ online: 'Online', seen: 'Seen', banned: 'Banned', whitelist: 'Whitelist' }[key]}
              <span className="text-muted-foreground tabular-nums">{counts[key]}</span>
            </TabsTab>
          ))}
        </TabsList>
      </Tabs>
      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" aria-label="Search this list" />
      </InputGroup>

      <div className="h-80 overflow-y-auto lg:h-[26rem]">
        {tab === 'online' &&
          (data.online.length === 0 ? (
            <EmptyState
              compact
              type="noPlayers"
              title="Nobody online"
              description="Players show up here when they connect."
              action={seen.length > 0 ? { label: `See ${seen.length} who played before`, onClick: () => onTabChange('seen') } : undefined}
            />
          ) : (
            data.online
              .filter((player) => matches(player.name))
              .map((player) => {
                const detail = data.details.get(player.name)
                const health = detail?.health?.overallBodyHealth
                const powers = data.powersOf(player.name)
                const stat = stats[player.name]
                return (
                  <Row key={player.name} selected={selected === player.name} onClick={() => onSelect(player.name)}>
                    <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
                      {player.name}
                    </span>
                    {powers?.godMode && <Ghost className="size-3.5 text-muted-foreground" aria-label="God mode" />}
                    {powers?.invisible && <Eye className="size-3.5 text-muted-foreground" aria-label="Invisible" />}
                    {powers?.noclip && <Layers className="size-3.5 text-muted-foreground" aria-label="Noclip" />}
                    {detail?.health?.isInfected && <Skull className="size-3.5 text-destructive-foreground" aria-label="Infected" />}
                    {typeof health === 'number' && (
                      <span
                        className={cn('flex items-center gap-0.5 text-xs tabular-nums', health >= 60 ? 'text-muted-foreground' : health >= 30 ? 'text-warning-foreground' : 'text-destructive-foreground')}
                        title={`Health ${Math.round(health)}%`}
                      >
                        <Heart className="size-3" />
                        {Math.round(health)}%
                      </span>
                    )}
                    {stat && <span className="text-xs text-muted-foreground tabular-nums">{formatPlaytime(stat.total_playtime_seconds)}</span>}
                  </Row>
                )
              })
          ))}

        {tab === 'seen' &&
          (data.stats.isPending ? (
            <Skeleton className="h-24" />
          ) : seen.length === 0 ? (
            <EmptyState compact type="noPlayers" title="Nobody yet" description="Players show up here after they leave." />
          ) : (
            seen
              .filter((stat) => matches(stat.player_name))
              .map((stat) => (
                <Row key={stat.player_name} selected={selected === stat.player_name} onClick={() => onSelect(stat.player_name)} title={stat.last_seen ? `Last seen ${new Date(stat.last_seen).toLocaleString('en')}` : undefined}>
                  <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
                    {stat.player_name}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">{formatPlaytime(stat.total_playtime_seconds)}</span>
                  {stat.last_seen && <span className="w-20 text-end text-xs text-muted-foreground">{day(stat.last_seen)}</span>}
                </Row>
              ))
          ))}

        {tab === 'banned' &&
          (bans.length === 0 ? (
            <EmptyState compact type="noData" title="No Steam ID bans" description="Ban a Steam ID from the menu at the top." />
          ) : (
            bans
              .filter((ban) => matches(ban.steamId, ban.reason))
              .map((ban) => (
                <Row key={ban.steamId}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm">{ban.steamId}</p>
                    <p className="truncate text-xs text-muted-foreground" title={ban.reason}>
                      {[ban.reason, ban.banned_at && day(ban.banned_at)].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <Button size="xs" variant="outline" onClick={() => void unbanSteamId(ban.steamId)} disabled={busy !== null}>
                    Unban
                  </Button>
                </Row>
              ))
          ))}

        {tab === 'whitelist' &&
          (!whitelist ? (
            <Skeleton className="h-24" />
          ) : !whitelist.available ? (
            <EmptyState compact type="accessDenied" title="Whitelist unavailable" description={whitelist.reason || "The panel couldn't read this server's account database."} />
          ) : (
            <>
              {whitelist.accounts.length === 0 && <EmptyState compact type="noPlayers" title="No accounts" description="Add one from the menu at the top." />}
              {whitelist.accounts
                .filter((account) => matches(account.username, account.displayName, account.steamId, account.role))
                .map((account) => {
                  const online = onlineNames.has(account.username.toLowerCase())
                  return (
                    <Row key={`${account.id}-${account.username}`}>
                      <span className={cn('size-2 shrink-0 rounded-full', online ? 'bg-success' : 'bg-muted-foreground/40')} aria-hidden />
                      <button type="button" className="min-w-0 flex-1 text-start" onClick={() => onSelect(account.username)}>
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{account.username}</span>
                          <Badge variant="outline">{account.role}</Badge>
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[account.steamId, account.lastConnection && `last ${day(account.lastConnection)}`].filter(Boolean).join(' · ') || (online ? 'Online' : 'Offline')}
                        </span>
                      </button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove ${account.username} from the whitelist`}
                        disabled={busy !== null}
                        onClick={() => void run(`remove:${account.username}`, `Removed ${account.username}`, () => playersApi.removeFromWhitelist(account.username))}
                      >
                        <UserMinus />
                      </Button>
                    </Row>
                  )
                })}
              <div className="mt-3 grid gap-2 border-t pt-3">
                <p className="flex justify-between text-sm font-medium">
                  Allowed Steam IDs <span className="text-muted-foreground tabular-nums">{whitelist.allowedSteamIds.length}</span>
                </p>
                <div className="flex gap-2">
                  <Input
                    value={steamIdInput}
                    onChange={(event) => setSteamIdInput(sanitizeSteamId(event.target.value))}
                    placeholder="76561198XXXXXXXXX"
                    inputMode="numeric"
                    className="font-mono"
                    aria-label="Steam ID to allow"
                  />
                  <Button
                    variant="outline"
                    disabled={busy !== null || steamIdInput.length !== 17}
                    onClick={async () => {
                      if (await run('allow', `Allowed ${steamIdInput}`, () => playersApi.addAllowedSteamId(steamIdInput))) setSteamIdInput('')
                    }}
                  >
                    <Plus />
                    Add
                  </Button>
                </div>
                {whitelist.allowedSteamIds
                  .filter((steamId) => matches(steamId))
                  .map((steamId) => (
                    <Row key={steamId}>
                      <span className="flex-1 font-mono text-sm">{steamId}</span>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove allowed Steam ID ${steamId}`}
                        disabled={busy !== null}
                        onClick={() => void run(`disallow:${steamId}`, `Removed ${steamId}`, () => playersApi.removeAllowedSteamId(steamId))}
                      >
                        <Trash2 />
                      </Button>
                    </Row>
                  ))}
              </div>
            </>
          ))}
      </div>

      <InputGroup>
        <InputGroupAddon className="text-muted-foreground">Name</InputGroupAddon>
        <InputGroupInput
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
          placeholder="Or type any username"
          aria-label="Player name"
          className="font-mono"
        />
      </InputGroup>
    </Card>
  )
}
