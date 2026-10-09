import { useDeferredValue, useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, GripVertical, Search, Wand2 } from 'lucide-react'
import { buildRequiresMap, computeAutoSortedOrder, type AutoSortResult } from '@/lib/modLoadOrder'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/EmptyState'
import { SaveBar } from '@/components/settings-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { notify, plural } from './modsShared'
import type { ConflictScan } from './useConflictScan'
import type { ModsData } from './useModsData'

/** The order Mods= loads in. Later mods win when two touch the same file. */
export function LoadOrderView({ data, scan }: { data: ModsData; scan: ConflictScan }) {
  const { orderedModIds, setOrderedModIds, iniConfig, mods, hasModOrderChanged, serverChangedSinceLoad } = data
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim().toLowerCase())
  const [dragged, setDragged] = useState<number | null>(null)
  const [preview, setPreview] = useState<AutoSortResult | null>(null)

  const names = new Map<string, string>()
  for (const details of Object.values(iniConfig?.workshopModMap ?? {})) {
    for (const entry of details) if (entry.name && entry.name !== entry.id) names.set(entry.id, entry.name)
  }
  for (const mod of mods) {
    for (const entry of iniConfig?.workshopModMap?.[mod.workshop_id] ?? []) if (!names.has(entry.id) && mod.name) names.set(entry.id, mod.name)
  }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= orderedModIds.length) return
    const next = [...orderedModIds]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setOrderedModIds(next)
  }

  const autoSort = () => {
    const result = computeAutoSortedOrder(orderedModIds, buildRequiresMap(iniConfig?.workshopModMap))
    if (result.appliedEdges === 0) {
      notify(
        result.missing.length ? 'Nothing to sort by' : 'No dependency data',
        result.missing.length
          ? `${plural(result.missing.length, 'declared requirement isn’t', 'declared requirements aren’t')} enabled, so none of the enabled mods depend on each other.`
          : 'None of the enabled mods declare a require in mod.info, so there is nothing to sort by.',
      )
      return
    }
    if (result.moved.length === 0) {
      notify(
        'Already in order',
        result.cycles.length
          ? `Every dependency that can load first already does. ${plural(result.cycles.length, 'circular dependency')} can't be ordered.`
          : `All ${result.appliedEdges} declared dependencies already load before the mods that need them.`,
      )
      return
    }
    setPreview(result)
  }

  const applySort = () => {
    if (!preview) return
    setOrderedModIds(preview.order)
    notify('Sorted', `${plural(preview.moved.length, 'mod')} moved. Save to write the order to the server config.`)
    setPreview(null)
  }

  const save = () => void scan.saveOrder(orderedModIds, { title: 'Load order saved', description: 'The server config has the new order.' }, "Couldn't save the load order")
  const reset = () => {
    setPreview(null)
    if (iniConfig) setOrderedModIds(iniConfig.modIds)
  }

  if (orderedModIds.length === 0) {
    return <EmptyState type="noMods" title="Nothing to order" description="Enable mod IDs in Mod IDs first." />
  }

  const rows = orderedModIds.map((modId, index) => ({ modId, index })).filter(({ modId }) => !query || modId.toLowerCase().includes(query) || names.get(modId)?.toLowerCase().includes(query))

  return (
    <div className="grid gap-3 pb-16">
      {serverChangedSinceLoad && (
        <Alert variant="error">
          <AlertTitle>The selected server changed</AlertTitle>
          <AlertDescription>This order belongs to the previous server. Reset it before saving.</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="max-w-sm min-w-48 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a mod ID" aria-label="Find a mod ID" />
        </InputGroup>
        <p className="text-sm text-muted-foreground">{search ? 'Clear the search to drag.' : 'Drag rows, or use the arrows.'}</p>
        <Button size="sm" variant="outline" className="ms-auto" onClick={autoSort} disabled={scan.savingOrder || !!preview}>
          <Wand2 />
          Sort by dependencies
        </Button>
      </div>

      {preview && (
        <Card className="gap-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-medium">{plural(preview.moved.length, 'mod')} would move</p>
              <p className="text-sm text-muted-foreground">
                Based on {plural(preview.appliedEdges, 'dependency', 'dependencies')} in mod.info. Mods without one keep your order.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={applySort}>
                Apply
              </Button>
            </div>
          </div>
          <div className="max-h-40 overflow-y-auto">
            {preview.moved.map((entry) => (
              <p key={entry.modId} className="flex items-center gap-2 text-sm">
                <span className="w-8 text-end text-muted-foreground tabular-nums">#{entry.from}</span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <span className="w-8 text-end tabular-nums">#{entry.to}</span>
                <code className="font-mono">{entry.modId}</code>
                {names.get(entry.modId) && <span className="truncate text-muted-foreground">{names.get(entry.modId)}</span>}
              </p>
            ))}
          </div>
          {preview.cycles.map((group) => (
            <p key={group.join('|')} className="text-sm text-warning-foreground">
              Circular dependency between {group.join(', ')}. No order satisfies it, so these keep their order relative to each other.
            </p>
          ))}
          {preview.missing.length > 0 && (
            <p className="text-sm text-muted-foreground">{plural(preview.missing.length, 'required mod isn’t', 'required mods aren’t')} enabled and couldn't be ordered. Conflicts lists them.</p>
          )}
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        <div className="max-h-[calc(100dvh-22rem)] min-h-60 overflow-y-auto">
          {rows.map(({ modId, index }) => (
            <div
              key={`${modId}-${index}`}
              draggable={!search.trim()}
              onDragStart={() => setDragged(index)}
              onDragOver={(event) => {
                event.preventDefault()
                if (dragged === null || dragged === index) return
                move(dragged, index)
                setDragged(index)
              }}
              onDragEnd={() => setDragged(null)}
              className={cn('flex items-center gap-2 border-b px-3 py-1 text-sm last:border-b-0 hover:bg-accent/50', !search.trim() && 'cursor-grab', dragged === index && 'opacity-40')}
            >
              <GripVertical className="size-4 shrink-0 text-muted-foreground/60" />
              <span className="w-7 shrink-0 text-end text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <code className="shrink-0 font-mono">{modId}</code>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{names.get(modId)}</span>
              <Button size="icon-xs" variant="ghost" onClick={() => move(index, index - 1)} disabled={index === 0} aria-label={`Move ${modId} up`}>
                <ArrowUp />
              </Button>
              <Button size="icon-xs" variant="ghost" onClick={() => move(index, index + 1)} disabled={index === orderedModIds.length - 1} aria-label={`Move ${modId} down`}>
                <ArrowDown />
              </Button>
            </div>
          ))}
        </div>
      </Card>

      {hasModOrderChanged && (
        <SaveBar message="Unsaved load order" saving={scan.savingOrder} saveLabel="Save order" saveDisabled={serverChangedSinceLoad} onSave={save} onDiscard={reset} />
      )}
    </div>
  )
}
