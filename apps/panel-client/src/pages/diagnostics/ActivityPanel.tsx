import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, Copy, Pause, Play, RefreshCw, Search } from 'lucide-react'
import { debugApi, type ActivityEntry, type ActivitySource } from '@/lib/api'
import { cn, copyText } from '@/lib/utils'
import { EmptyState } from '@/components/EmptyState'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { toastManager } from '@/components/ui/toast'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const SOURCES = [
  { value: 'all', label: 'All sources' },
  { value: 'rcon', label: 'RCON' },
  { value: 'player', label: 'Players' },
  { value: 'server', label: 'Server' },
] as const
const SOURCE_LABEL: Record<ActivitySource, string> = { rcon: 'RCON', player: 'Player', server: 'Server' }

type Result = 'all' | 'ok' | 'failed'

async function copyEntry(entry: ActivityEntry) {
  const ok = await copyText(`[${new Date(entry.timestamp).toISOString()}] [${entry.source}] ${entry.success ? 'OK' : 'FAIL'} ${entry.action}\n${entry.detail}`)
  toastManager.add(ok ? { title: 'Entry copied', type: 'success' } : { title: "Couldn't copy", description: 'Select the row and press Ctrl+C.', type: 'error' })
}

/** RCON commands, player events and server events, newest first. */
export function ActivityPanel() {
  const [source, setSource] = useState<ActivitySource | 'all'>('all')
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<Result>('all')
  const [paused, setPaused] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const query = useQuery({
    queryKey: ['diagnostics', 'activity', source],
    queryFn: () => debugApi.getActivity(source),
    refetchInterval: paused ? false : 15_000,
    retry: false,
  })
  const entries = query.data?.entries ?? []
  const failed = entries.filter((entry) => !entry.success).length

  const needle = search.trim().toLowerCase()
  const shown = entries.filter(
    (entry) =>
      (result === 'all' || entry.success === (result === 'ok')) &&
      (!needle || `${entry.action} ${entry.detail} ${entry.source}`.toLowerCase().includes(needle)),
  )

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select items={SOURCES} value={source} onValueChange={(value) => setSource(value as ActivitySource | 'all')}>
          <SelectTrigger className="w-36" aria-label="Source">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {SOURCES.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <InputGroup className="w-full sm:w-64">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput type="search" placeholder="Search actions and details" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={200} aria-label="Search activity" />
        </InputGroup>
        <ToggleGroup size="sm" variant="outline" value={[result]} onValueChange={(value) => setResult((value[0] as Result) ?? 'all')} aria-label="Result">
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="ok">Succeeded</ToggleGroupItem>
          <ToggleGroupItem value="failed">Failed{failed > 0 ? ` (${failed})` : ''}</ToggleGroupItem>
        </ToggleGroup>
        <span className="flex-1" />
        <Toggle size="sm" variant="outline" pressed={paused} onPressedChange={setPaused} aria-label={paused ? 'Resume updates' : 'Pause updates'}>
          {paused ? <Play /> : <Pause />}
          {paused ? 'Resume' : 'Pause'}
        </Toggle>
        <Button size="icon-sm" variant="ghost" onClick={() => void query.refetch()} aria-label="Refresh now">
          {query.isFetching ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>

      {query.isPending ? (
        <Card className="flex-row justify-center py-16">
          <Spinner />
        </Card>
      ) : entries.length === 0 ? (
        <EmptyState type="noData" title="No activity yet" description="RCON commands, player events and server events show up here as they happen." />
      ) : shown.length === 0 ? (
        <EmptyState type="noResults" title="Nothing matches" description="Change the search or the result filter." />
      ) : (
        <Card className="overflow-hidden p-0">
          <ul className="h-[calc(100dvh-20rem)] min-h-72 divide-y overflow-auto text-sm">
            {shown.map((entry) => {
              const key = `${entry.source}-${entry.id}`
              const expanded = open.has(key)
              return (
                <li key={key} className={cn('group', !entry.success && 'bg-destructive/4')}>
                  <div className="flex items-start gap-3 px-3 py-2">
                    <button type="button" onClick={() => toggle(key)} aria-expanded={expanded} className="flex min-w-0 flex-1 items-start gap-3 text-start">
                      <span className="w-20 shrink-0 font-mono text-xs leading-5 text-muted-foreground tabular-nums" title={new Date(entry.timestamp).toLocaleString('en')}>
                        {new Date(entry.timestamp).toLocaleTimeString('en')}
                      </span>
                      {entry.success ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
                      <Badge variant="outline" className="shrink-0">
                        {SOURCE_LABEL[entry.source] ?? entry.source}
                      </Badge>
                      <span className={cn('font-medium', expanded ? 'min-w-0 wrap-break-word' : 'max-w-1/2 shrink-0 truncate')}>{entry.action}</span>
                      <span className={cn('min-w-0 text-muted-foreground', expanded ? 'wrap-break-word whitespace-pre-wrap' : 'truncate')}>{entry.detail}</span>
                    </button>
                    <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void copyEntry(entry)} aria-label="Copy entry">
                      <Copy />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="flex justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
            <span className="tabular-nums">{shown.length === entries.length ? `${entries.length} entries` : `${shown.length} of ${entries.length} entries`}</span>
            <span>{paused ? 'Paused' : `Updated ${new Date(query.dataUpdatedAt).toLocaleTimeString('en')}, every 15s`}</span>
          </div>
        </Card>
      )}
    </div>
  )
}
