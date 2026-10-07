import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Map as MapIcon, MapPin, Package, Search, Thermometer, TrendingUp, UserMinus, UserPlus } from 'lucide-react'
import { gameIntegrationApi, playersApi, type GameIntegrationPlayer } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/EmptyState'
import { HelpTip } from '@/components/HelpTip'
import { NumberInput } from '@/components/NumberInput'
import { SpawnBrowser } from '@/components/SpawnBrowser'
import { PlayerActions, usePlayerAction } from '@/components/players/PlayerActions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { MenuItem, MenuSeparator } from '@/components/ui/menu'
import { Meter, MeterIndicator, MeterTrack } from '@/components/ui/meter'
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { toastManager } from '@/components/ui/toast'
import { formatPlaytime, type PlayersData } from './usePlayersData'

interface Perk {
  id: string
  label: string
  category: string
}

interface ActivityEntry {
  id: number
  player_name: string
  action: string
  details: string | null
  logged_at: string
}

const ACTIVITY_LIMIT = 200
const ACTION_BADGE: Record<string, 'success' | 'secondary' | 'warning' | 'error'> = {
  connect: 'success',
  disconnect: 'secondary',
  kick: 'warning',
  ban: 'error',
  death: 'warning',
}

/** A 0 to 1 vital as a meter. `goodWhenLow` flips the colors for hunger, thirst and fatigue. */
function Vital({ label, value, goodWhenLow }: { label: string; value: number; goodWhenLow?: boolean }) {
  const severity = goodWhenLow ? value : 1 - value
  return (
    <div className="grid grid-cols-[5rem_1fr_3rem] items-center gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Meter value={Math.round(Math.max(0, Math.min(1, value)) * 100)} aria-label={label}>
        <MeterTrack className="h-1.5 rounded-full">
          <MeterIndicator className={cn('rounded-full', severity < 0.5 ? 'bg-success' : severity < 0.75 ? 'bg-warning' : 'bg-destructive')} />
        </MeterTrack>
      </Meter>
      <span className="text-end tabular-nums">{Math.round(value * 100)}%</span>
    </div>
  )
}

function StatusTab({ player, online, data }: { player: string; online: boolean; data: PlayersData }) {
  const vitals = useQuery({
    queryKey: ['game-integration', 'player', player],
    queryFn: async () => {
      const response = await gameIntegrationApi.getPlayerDetails(player)
      if (!response.success) throw new Error((response as { error?: string }).error || 'Live status is unavailable.')
      return response.data as GameIntegrationPlayer & { health?: { wetness?: number } }
    },
    enabled: online && data.integrationConnected,
    retry: false,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })

  if (!online) return <p className="text-sm text-muted-foreground">{player} is offline. Live status shows while they play.</p>
  if (!data.integrationConnected) return <p className="text-sm text-muted-foreground">Live status needs the game integration. Set it up in Server settings.</p>
  if (vitals.isPending) return <Skeleton className="h-40" />
  if (vitals.isError) return <p className="text-sm text-destructive-foreground">{getUserErrorMessage(vitals.error, 'Live status is unavailable.')}</p>

  const v = vitals.data
  const tags = [
    v.accessLevel && v.accessLevel !== 'none' && v.accessLevel !== 'user' && { label: v.accessLevel, variant: 'warning' as const },
    v.health?.isInfected && { label: 'Infected', variant: 'error' as const },
    v.health?.isBleeding && { label: 'Bleeding', variant: 'error' as const },
    v.isAsleep && { label: 'Asleep', variant: 'secondary' as const },
    v.isSneaking && { label: 'Sneaking', variant: 'secondary' as const },
    v.isRunning && { label: 'Running', variant: 'secondary' as const },
  ].filter(Boolean) as Array<{ label: string; variant: 'warning' | 'error' | 'secondary' }>
  const other = (['endurance', 'stress', 'boredom', 'unhappiness', 'pain'] as const).filter((key) => v.stats?.[key] !== undefined)

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {tags.map((tag) => (
          <Badge key={tag.label} variant={tag.variant}>
            {tag.label}
          </Badge>
        ))}
        {typeof v.x === 'number' && typeof v.y === 'number' && (
          <Button
            size="xs"
            variant="ghost"
            render={<Link to="/map" search={{ x: Math.round(v.x), y: Math.round(v.y), z: v.z ?? 0 }} />}
            title="Show on the map"
          >
            <MapPin />
            <span className="font-mono tabular-nums">
              {Math.round(v.x)}, {Math.round(v.y)}
              {typeof v.z === 'number' ? `, ${v.z}` : ''}
            </span>
          </Button>
        )}
        {v.health?.temperature !== undefined && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground tabular-nums">
            <Thermometer className="size-4" />
            {Math.round(v.health.temperature * 10) / 10}°
          </span>
        )}
        {v.health?.wetness !== undefined && <span className="text-sm text-muted-foreground tabular-nums">Wet {Math.round(v.health.wetness * 100)}%</span>}
      </div>
      <div className="grid gap-2.5">
        {v.health?.overallBodyHealth !== undefined && <Vital label="Health" value={v.health.overallBodyHealth / 100} />}
        {(['hunger', 'thirst', 'fatigue'] as const).map((key) =>
          v.stats?.[key] === undefined ? null : <Vital key={key} label={key[0].toUpperCase() + key.slice(1)} value={v.stats[key]} goodWhenLow />,
        )}
      </div>
      {other.length > 0 && (
        <div className="grid gap-2 border-t pt-3">
          <p className="flex items-center gap-1 text-sm font-medium">
            Other stats
            <HelpTip label="Other stats">
              Raw numbers from the game integration. Not every one of them is known to be on a 0 to 1 scale, so the panel doesn't guess with a colored bar.
            </HelpTip>
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            {other.map((key) => (
              <div key={key} className="flex justify-between gap-2">
                <dt className="text-muted-foreground capitalize">{key}</dt>
                <dd className="tabular-nums">{Math.round((v.stats?.[key] ?? 0) * 100) / 100}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}

function GiveTab({ player, onGiveItems }: { player: string; onGiveItems: () => void }) {
  const { busy, run } = usePlayerAction()
  const [perk, setPerk] = useState('')
  const [amount, setAmount] = useState(100)
  const { data: perks = [] } = useQuery({
    queryKey: ['players', 'perks'],
    queryFn: async () => {
      const data = (await playersApi.getPerks()) as { catalog?: Perk[]; perks?: string[] }
      return data.catalog ?? (data.perks ?? []).map((id) => ({ id, label: id, category: 'Skills' }))
    },
    staleTime: Infinity,
  })
  const groups = perks.reduce((byCategory, item) => byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item]), new Map<string, Perk[]>())

  return (
    <div className="grid gap-4">
      <button type="button" onClick={onGiveItems} className="flex items-center gap-3 rounded-xl border p-4 text-start hover:bg-accent">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
          <Package className="size-4" />
        </span>
        <span className="grid flex-1">
          <span className="font-medium">Give items</span>
          <span className="text-sm text-muted-foreground">Browse the item catalog and give as many as you like to {player}.</span>
        </span>
      </button>
      <div className="grid gap-3 rounded-xl border p-4">
        <p className="flex items-center gap-2 font-medium">
          <TrendingUp className="size-4" />
          Give XP
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-48 flex-1">
            <FieldLabel>Skill</FieldLabel>
            <Select items={perks.map((item) => ({ value: item.id, label: item.label }))} value={perk || null} onValueChange={(value) => setPerk(String(value ?? ''))}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a skill" />
              </SelectTrigger>
              <SelectPopup>
                {[...groups].map(([category, items]) => (
                  <SelectGroup key={category}>
                    <SelectGroupLabel>{category}</SelectGroupLabel>
                    {items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field className="w-28">
            <FieldLabel>Amount</FieldLabel>
            <NumberInput value={amount} onChange={setAmount} min={1} max={10000} />
          </Field>
          <Button disabled={busy !== null || !perk || !Number.isFinite(amount)} onClick={() => void run('xp', `Gave ${amount} XP to ${player}`, () => playersApi.addXp(player, perk, amount))}>
            Give XP
          </Button>
        </div>
      </div>
    </div>
  )
}

function HistoryTab({ player, data }: { player: string; data: PlayersData }) {
  const [filter, setFilter] = useState('')
  const stat = data.stats.data?.[player]
  const activity = useQuery({
    queryKey: ['players', 'activity-log', filter],
    queryFn: async () => ((await playersApi.getActivityLogs(filter || undefined, ACTIVITY_LIMIT)) as { logs?: ActivityEntry[] }).logs ?? [],
    retry: false,
  })

  return (
    <div className="grid gap-5">
      {data.stats.isPending ? (
        <Skeleton className="h-20" />
      ) : data.stats.isError ? (
        <Alert variant="error">
          <AlertDescription>Playtime is unavailable right now.</AlertDescription>
        </Alert>
      ) : stat ? (
        <>
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
            {[
              ['Playtime', formatPlaytime(stat.total_playtime_seconds)],
              ['Sessions', stat.session_count],
              ['Deaths', stat.deaths ?? 0],
              ['First seen', new Date(stat.first_seen).toLocaleDateString('en')],
              ['Last seen', new Date(stat.last_seen).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="grid gap-2">
            <p className="text-sm font-medium">Sessions in the last 30 days</p>
            {stat.sessions?.length ? (
              <div className="max-h-48 overflow-auto rounded-lg border">
                {stat.sessions.map((session, index) => (
                  <div key={`${session.start}-${index}`} className="flex flex-wrap justify-between gap-x-4 border-b px-3 py-2 text-sm last:border-b-0">
                    <span>{new Date(session.start).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    <span className="text-muted-foreground">{formatPlaytime(session.duration_seconds)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No finished sessions in the last 30 days.</p>
            )}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No playtime recorded for {player} yet.</p>
      )}

      <div className="grid gap-2 border-t pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Activity log, all players</p>
          <InputGroup className="w-56">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by name" aria-label="Filter the activity log by player" />
          </InputGroup>
        </div>
        <div className="max-h-72 overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Player</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="hidden sm:table-cell">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(activity.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    {activity.isPending ? 'Loading…' : activity.isError ? 'The activity log is unavailable.' : 'Nothing logged yet.'}
                  </TableCell>
                </TableRow>
              ) : (
                (activity.data ?? []).map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(entry.logged_at).toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' })}</TableCell>
                    <TableCell className="font-medium">{entry.player_name}</TableCell>
                    <TableCell>
                      <Badge variant={ACTION_BADGE[entry.action] ?? 'secondary'}>{entry.action.replace(/_/g, ' ')}</Badge>
                    </TableCell>
                    <TableCell className="hidden max-w-60 truncate text-muted-foreground sm:table-cell">{entry.details || '–'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {(activity.data?.length ?? 0) >= ACTIVITY_LIMIT && <p className="text-sm text-muted-foreground">Showing the newest {ACTIVITY_LIMIT}. Older entries aren't shown.</p>}
      </div>
    </div>
  )
}

/** The selected player: who they are, every action on them, and Status, Give and History. */
export function PlayerPanel({ player, data, onAddAccount }: { player: string; data: PlayersData; onAddAccount: (name: string) => void }) {
  const [spawnOpen, setSpawnOpen] = useState(false)
  const { busy, run } = usePlayerAction(data.refresh)

  if (!player) {
    return (
      <Card>
        <EmptyState type="noPlayers" title="Pick a player" description="Choose someone from the list, or type any username under it." />
      </Card>
    )
  }

  const online = data.online.some((entry) => entry.name === player)
  const stat = data.stats.data?.[player]
  const whitelist = data.whitelist.data
  const notWhitelisted = !!whitelist?.available && !whitelist.accounts.some((account) => account.username === player)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5 text-xl">
          <span className="truncate" dir="auto">
            {player}
          </span>
          <Badge variant={online ? 'success' : 'secondary'}>{online ? 'Online' : 'Offline'}</Badge>
        </CardTitle>
        <CardDescription>
          {stat ? `${formatPlaytime(stat.total_playtime_seconds)} played over ${stat.session_count} sessions. Last seen ${new Date(stat.last_seen).toLocaleDateString('en')}.` : 'No playtime recorded yet.'}
        </CardDescription>
        <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">
          <PlayerActions
            player={player}
            powers={data.powersOf(player)}
            integrationConnected={data.integrationConnected}
            onChanged={data.refresh}
            extraItems={
              <>
                <MenuSeparator />
                {online && (
                  <MenuItem render={<Link to="/map" />}>
                    <MapIcon />
                    Find on the map
                  </MenuItem>
                )}
                {notWhitelisted ? (
                  <MenuItem onClick={() => onAddAccount(player)}>
                    <UserPlus />
                    Add to whitelist…
                  </MenuItem>
                ) : (
                  <MenuItem
                    disabled={busy !== null}
                    onClick={() => void run('remove', `Removed ${player} from the whitelist`, () => playersApi.removeFromWhitelist(player))}
                  >
                    <UserMinus />
                    Remove from whitelist
                  </MenuItem>
                )}
              </>
            }
          />
        </div>
      </CardHeader>
      <CardPanel>
        <Tabs defaultValue="status" className="gap-4">
          <TabsList variant="underline" className="-ms-1">
            <TabsTab value="status">Status</TabsTab>
            <TabsTab value="give">Give</TabsTab>
            <TabsTab value="history">History</TabsTab>
          </TabsList>
          <TabsPanel value="status">
            <StatusTab player={player} online={online} data={data} />
          </TabsPanel>
          <TabsPanel value="give">
            <GiveTab player={player} onGiveItems={() => setSpawnOpen(true)} />
          </TabsPanel>
          <TabsPanel value="history">
            <HistoryTab player={player} data={data} />
          </TabsPanel>
        </Tabs>
      </CardPanel>
      <SpawnBrowser
        open={spawnOpen}
        onOpenChange={setSpawnOpen}
        playerName={player}
        onSpawn={async (id, qty = 1) => {
          try {
            await playersApi.addItem(player, id, qty)
            toastManager.add({ title: 'Item given', description: `${id.replace(/^Base\./, '')}${qty > 1 ? ` × ${qty}` : ''} to ${player}`, type: 'success' })
          } catch (error) {
            toastManager.add({ title: 'Could not give the item', description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
            throw error
          }
        }}
      />
    </Card>
  )
}
