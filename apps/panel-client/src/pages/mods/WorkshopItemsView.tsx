import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CheckCircle2, ChevronRight, Clock, Library, Package, PlusCircle, RefreshCw, Search, Trash2 } from 'lucide-react'
import { modsApi } from '@/lib/api'
import { isDemoMode } from '@/lib/demo'
import type { TrackedMod } from '@/lib/modsShared'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/contexts/ConfirmContext'
import { EmptyState } from '@/components/EmptyState'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Toggle } from '@/components/ui/toggle'
import { ModRow, WorkshopIdChip, WorkshopLink, WorkshopThumb } from './ModRow'
import { notify, plural } from './modsShared'
import type { ModsData } from './useModsData'

type Group = 'update' | 'unchecked' | 'current'
type Item = { type: 'header'; group: Group; count: number } | { type: 'hint' } | { type: 'mod'; mod: TrackedMod; group: Group }

/** Removes mods from tracking and from the server config. Files stay on disk. */
export function useRemoveMods(data: ModsData) {
  const confirm = useConfirm()
  return async (workshopIds: string[], names?: string[]) => {
    const one = workshopIds.length === 1
    const confirmed = await confirm({
      title: one ? 'Remove this mod from the server?' : `Remove ${workshopIds.length} mods from the server?`,
      description: 'They come out of the server config and stop loading. The Workshop files stay on disk, so adding them back is instant.',
      items: names && names.length > 1 ? names.slice(0, 12) : undefined,
      confirmLabel: one ? 'Remove' : `Remove ${workshopIds.length}`,
      destructive: true,
    })
    if (!confirmed) return false
    return data.runExclusive("Couldn't remove", async () => {
      const result = (await modsApi.batchRemove(workshopIds)) as { total?: number; dbRemoved?: number; dbFailed?: number; error?: string }
      if (result.error) throw new Error(result.error)
      if ((result.dbFailed ?? 0) > 0) notify('Partly removed', `Removed ${result.dbRemoved ?? 0}. ${result.dbFailed} couldn't be untracked.`, 'error')
      else notify(plural(result.total ?? workshopIds.length, 'mod') + ' removed', 'Removed from tracking and the server config.', 'success')
      void data.fetchData()
    })
  }
}

/** Every Workshop item the server loads, grouped by update status. */
export function WorkshopItemsView({ data, onAdd, onImport }: { data: ModsData; onAdd: () => void; onImport: () => void }) {
  const { mods, iniConfig, loading, collectionStatus } = data
  const demo = isDemoMode()
  const removeMods = useRemoveMods(data)
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim().toLowerCase())
  const [updatesOnly, setUpdatesOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Record<'unchecked' | 'current', boolean>>({ unchecked: false, current: false })
  const listRef = useRef<HTMLDivElement>(null)

  const configured = useMemo(() => new Set(iniConfig?.workshopIds ?? []), [iniConfig?.workshopIds])
  const groups = useMemo(() => {
    const result = { update: [] as TrackedMod[], unchecked: [] as TrackedMod[], current: [] as TrackedMod[] }
    const sorted = [...mods]
      .filter((mod) => !query || mod.name?.toLowerCase().includes(query) || mod.workshop_id.includes(query))
      .filter((mod) => !updatesOnly || mod.update_available)
      .sort((a, b) => b.update_available - a.update_available || (a.name || '').localeCompare(b.name || ''))
    for (const mod of sorted) {
      // Items missing from WorkshopItems= belong to the Not loaded view.
      if (iniConfig && !configured.has(mod.workshop_id)) continue
      if (mod.update_available) result.update.push(mod)
      else if (!mod.last_checked) result.unchecked.push(mod)
      else result.current.push(mod)
    }
    return result
  }, [mods, query, updatesOnly, iniConfig, configured])
  const visible = [...groups.update, ...groups.unchecked, ...groups.current]

  // Searching opens every group; with only unchecked items, that group opens by itself.
  const expanded = {
    unchecked: !!query || open.unchecked || (groups.update.length === 0 && groups.current.length === 0),
    current: !!query || open.current,
  }

  const items: Item[] = []
  if (groups.update.length) {
    items.push({ type: 'header', group: 'update', count: groups.update.length })
    for (const mod of groups.update) items.push({ type: 'mod', mod, group: 'update' })
  }
  if (groups.unchecked.length) {
    items.push({ type: 'header', group: 'unchecked', count: groups.unchecked.length })
    if (!groups.update.length && !groups.current.length && !query) items.push({ type: 'hint' })
    if (expanded.unchecked) for (const mod of groups.unchecked) items.push({ type: 'mod', mod, group: 'unchecked' })
  }
  if (groups.current.length) {
    items.push({ type: 'header', group: 'current', count: groups.current.length })
    if (expanded.current) for (const mod of groups.current) items.push({ type: 'mod', mod, group: 'current' })
  }

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (items[index].type === 'mod' ? 80 : items[index].type === 'hint' ? 48 : 40),
    overscan: 10,
  })

  // Drop selections that are no longer in the list.
  useEffect(() => {
    const ids = new Set(mods.map((mod) => mod.workshop_id))
    setSelected((prev) => (Array.from(prev).every((id) => ids.has(id)) ? prev : new Set(Array.from(prev).filter((id) => ids.has(id)))))
  }, [mods])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const removeSelected = async () => {
    const ids = Array.from(selected)
    const names = ids.map((id) => mods.find((mod) => mod.workshop_id === id)?.name || id)
    if (await removeMods(ids, names)) setSelected(new Set())
  }

  if (mods.length === 0) {
    return (
      <Card className="p-6">
        <EmptyState type="noMods" title="No mods tracked yet" description="The panel watches tracked mods for Workshop updates, finds conflicts and keeps the load order. Your server downloads the files; the panel only tracks them." />
        <div className="mx-auto grid w-full max-w-2xl gap-2 sm:grid-cols-3">
          {[
            { icon: RefreshCw, title: 'Read the server config', body: 'Track what WorkshopItems= and Mods= already list.', action: () => void syncFromServer(data) },
            { icon: Library, title: 'Import a collection', body: 'Add every mod in a Steam Workshop collection.', action: onImport },
            { icon: PlusCircle, title: 'Add one mod', body: 'By its Workshop ID or link.', action: onAdd },
          ].map(({ icon: Icon, title, body, action }) => (
            <button key={title} type="button" onClick={action} disabled={loading} className="grid gap-1 rounded-xl border p-3 text-start hover:bg-accent disabled:opacity-60">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4 text-muted-foreground" />
                {title}
              </span>
              <span className="text-sm text-muted-foreground">{body}</span>
            </button>
          ))}
        </div>
      </Card>
    )
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="max-w-sm min-w-48 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or ID" aria-label="Search mods" maxLength={200} />
        </InputGroup>
        <Toggle variant="outline" size="sm" pressed={updatesOnly} onPressedChange={setUpdatesOnly}>
          Updates only
        </Toggle>
        {collectionStatus.configured && (
          <Badge
            variant={collectionStatus.error ? 'error' : collectionStatus.inSync ? 'success' : collectionStatus.drift > 0 ? 'warning' : 'outline'}
            render={<button type="button" onClick={() => void data.fetchCollectionStatus()} />}
            title={collectionStatus.error ? `Collection sync error: ${collectionStatus.error}` : collectionStatus.title ? `Collection "${collectionStatus.title}"` : 'Check the collection again'}
          >
            {collectionStatus.loading ? 'Checking the collection…' : collectionStatus.error ? 'Collection error' : collectionStatus.inSync ? 'Collection in sync' : `${collectionStatus.drift} differ from the collection`}
          </Badge>
        )}
        <div className="ms-auto flex items-center gap-2">
          {selected.size > 0 ? (
            <>
              <span className="text-sm text-muted-foreground">{selected.size} selected</span>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void removeSelected()} disabled={loading}>
                <Trash2 />
                Remove
              </Button>
            </>
          ) : (
            visible.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(visible.map((mod) => mod.workshop_id)))}>
                Select all ({visible.length})
              </Button>
            )
          )}
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        {items.length === 0 ? (
          <EmptyState compact type="noResults" title="Nothing matches" description="Try another search or turn off Updates only." action={{ label: 'Clear search', onClick: () => setSearch(''), variant: 'outline' }} />
        ) : (
          <div ref={listRef} className="h-[calc(100dvh-22rem)] min-h-80 overflow-y-auto">
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((row) => {
                const item = items[row.index]
                return (
                  <div key={row.key} data-index={row.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${row.start}px)` }}>
                    {item.type === 'header' && item.group === 'update' && (
                      <div className="flex items-center gap-2 border-b bg-warning/8 px-3 py-2 text-sm font-medium text-warning-foreground">
                        Updates available <Badge variant="warning">{item.count}</Badge>
                      </div>
                    )}
                    {item.type === 'header' && item.group !== 'update' && (
                      <button
                        type="button"
                        onClick={() => setOpen((prev) => ({ ...prev, [item.group]: !expanded[item.group as 'unchecked' | 'current'] }))}
                        aria-expanded={expanded[item.group as 'unchecked' | 'current']}
                        className="flex w-full items-center gap-2 border-b bg-muted/40 px-3 py-2 text-start text-sm font-medium hover:bg-muted"
                      >
                        <ChevronRight className={cn('size-4 text-muted-foreground transition-transform', expanded[item.group as 'unchecked' | 'current'] && 'rotate-90')} />
                        {item.group === 'unchecked' ? <Clock className="size-4 text-muted-foreground" /> : <CheckCircle2 className="size-4 text-success-foreground" />}
                        {item.group === 'unchecked' ? 'Never checked' : 'Up to date'}
                        <span className="text-muted-foreground tabular-nums">{item.count}</span>
                      </button>
                    )}
                    {item.type === 'hint' && <p className="border-b px-3 py-3 text-sm text-muted-foreground">Check for updates at the top to find out which of these have new versions.</p>}
                    {item.type === 'mod' && (() => {
                      const { mod } = item
                      const label = mod.name || `Mod ${mod.workshop_id}`
                      const isSelected = selected.has(mod.workshop_id)
                      const reveal = isSelected || selected.size > 0 ? '' : 'opacity-0 group-hover/row:opacity-100 focus-within:opacity-100'
                      return (
                        <ModRow
                          selected={isSelected}
                          leading={
                            <div className="flex items-center gap-3">
                              <div className={reveal}>
                                <Checkbox checked={isSelected} onCheckedChange={() => toggle(mod.workshop_id)} aria-label={`Select ${label}`} />
                              </div>
                              <WorkshopThumb wsId={mod.workshop_id} label={label} demo={demo} fallback={<Package className="size-5" />} />
                            </div>
                          }
                          title={<span className={cn('truncate', mod.update_available ? 'font-semibold' : 'font-medium')}>{label}</span>}
                          badges={
                            <>
                              {!configured.has(mod.workshop_id) && iniConfig && <Badge variant="error">Not in the config</Badge>}
                              {mod.update_available ? <Badge variant="warning">Update</Badge> : null}
                            </>
                          }
                          meta={
                            <>
                              <WorkshopIdChip wsId={mod.workshop_id} />
                              <span>{mod.last_checked ? `Checked ${new Date(mod.last_checked).toLocaleDateString('en')}` : 'Not checked yet'}</span>
                            </>
                          }
                          actions={
                            <div className={cn('flex items-center', reveal)}>
                              <WorkshopLink wsId={mod.workshop_id} label={label} />
                              <Button size="icon-sm" variant="ghost" onClick={() => void removeMods([mod.workshop_id])} disabled={loading} aria-label={`Remove ${label}`}>
                                <Trash2 />
                              </Button>
                            </div>
                          }
                        />
                      )
                    })()}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </Card>
      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Working…
        </p>
      )}
    </div>
  )
}

/** Tracks whatever WorkshopItems= and Mods= already list. */
export async function syncFromServer(data: ModsData) {
  await data.runExclusive("Couldn't read the server config", async () => {
    const result = await modsApi.syncFromServer()
    const parts = [`Tracking ${result.synced || 0} mods from the server config`]
    if (result.skippedNonMod > 0) parts.push(`${result.skippedNonMod} non-mod items skipped`)
    if (result.skippedIgnored > 0) parts.push(`${result.skippedIgnored} ignored`)
    notify('Synced', `${parts.join('. ')}.`, 'success')
    void data.fetchData()
  })
}
