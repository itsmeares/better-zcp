import { useDeferredValue, useState } from 'react'
import { Check, ChevronRight, Copy, ExternalLink, MoreHorizontal, Plus, Search, Trash2, TriangleAlert, Wrench, X } from 'lucide-react'
import { modsApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useLocalStorageState, type WsGroup } from '@/lib/modsShared'
import { cn, copyText } from '@/lib/utils'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { Toggle } from '@/components/ui/toggle'
import { ModRow, WorkshopIdChip, WorkshopLink } from './ModRow'
import { notify, plural, workshopUrl } from './modsShared'
import { useActiveMods, type ActiveMods } from './useActiveMods'
import type { ConflictScan } from './useConflictScan'
import type { DepSearch } from './useDepSearch'
import type { ModsData } from './useModsData'
import { useRemoveMods } from './WorkshopItemsView'

function copyWorkshopId(wsId: string) {
  copyText(wsId)
    .then(() => notify('Copied', `Workshop ID ${wsId}`))
    .catch(() => {})
}

/** One mod ID as a toggle. Its color says whether it's on and whether it clashes. */
function IdChip({ active, group, modId, enabled, onToggle }: { active: ActiveMods; group: WsGroup; modId: string; enabled: boolean; onToggle: () => void }) {
  const others = Array.from(active.siblings.get(group.wsId)?.get(modId) ?? [])
  const enabledIds = new Set(group.mods.filter((mod) => mod.enabled).map((mod) => mod.id))
  const clashing = enabled && others.some((other) => enabledIds.has(other))
  const duplicateIn = (active.duplicates.get(modId) ?? []).filter((wsId) => wsId !== group.wsId)
  const title = [
    modId,
    duplicateIn.length ? `Also in Workshop item ${duplicateIn.join(', ')}` : null,
    clashing ? `Shares files with ${others.filter((other) => enabledIds.has(other)).join(', ')}, which is also on. The one loaded last overwrites the other.` : others.length ? `A variant of ${others.join(', ')}. They share files, so only one should be on.` : null,
    enabled ? 'Click to turn off' : 'Click to turn on',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      title={title}
      className={cn(
        'inline-flex max-w-52 items-center gap-1 truncate rounded-sm border px-1.5 py-px font-mono text-xs',
        clashing ? 'border-destructive/40 bg-destructive/10 text-destructive-foreground' : enabled ? 'border-success/30 bg-success/10 text-success-foreground' : 'text-muted-foreground hover:text-foreground',
        duplicateIn.length && !clashing && 'border-warning/40',
      )}
    >
      {(clashing || others.length > 0) && <TriangleAlert className={cn('size-3 shrink-0', !clashing && 'text-warning-foreground')} />}
      <span className="truncate">{modId}</span>
    </button>
  )
}

function Inspector({ group, active, depSearch, onRemove }: { group: WsGroup; active: ActiveMods; depSearch: DepSearch; onRemove: () => void }) {
  const missing = Array.from(new Set(group.mods.flatMap((mod) => active.missingDeps.get(mod.id) ?? [])))
  const duplicates = group.mods.filter((mod) => active.duplicates.has(mod.id)).map((mod) => mod.id)
  const enabled = group.mods.filter((mod) => mod.enabled).length
  const parent = { parentName: active.groupLabel(group), parentWorkshopId: group.wsId }

  return (
    <Card className="gap-4 p-4 xl:sticky xl:top-4 xl:self-start" aria-label="Selected Workshop item">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={active.groupLabel(group)}>
            {active.groupLabel(group)}
          </p>
          <p className="font-mono text-xs text-muted-foreground">{group.wsId}</p>
        </div>
        <Badge variant={group.allEnabled ? 'success' : group.someEnabled ? 'warning' : 'outline'}>
          {enabled} of {group.mods.length} on
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant="outline" render={<a href={workshopUrl(group.wsId)} target="_blank" rel="noopener noreferrer" />}>
          <ExternalLink />
          Workshop
        </Button>
        <Button size="sm" variant="outline" onClick={() => copyWorkshopId(group.wsId)}>
          <Copy />
          Copy ID
        </Button>
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between text-sm font-medium">
          Mod IDs
          <Button size="xs" variant="ghost" onClick={() => void active.toggleGroup(group)}>
            {group.allEnabled ? 'Turn all off' : 'Turn all on'}
          </Button>
        </div>
        {group.mods.map((mod) => (
          <label key={mod.id} className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm', mod.enabled && 'border-success/30 bg-success/8')}>
            <Checkbox checked={mod.enabled} onCheckedChange={() => void active.toggleMod(mod, group.wsId)} />
            <code className="min-w-0 flex-1 truncate font-mono">{mod.id}</code>
            {(active.missingDeps.get(mod.id)?.length ?? 0) > 0 && <TriangleAlert className="size-3.5 text-destructive-foreground" aria-label="Missing a requirement" />}
            {active.duplicates.has(mod.id) && <Badge variant="warning">Duplicate</Badge>}
          </label>
        ))}
      </div>
      {missing.length > 0 && (
        <div className="grid gap-2 rounded-lg border border-destructive/30 bg-destructive/6 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-destructive-foreground">
            <TriangleAlert className="size-4" />
            Missing required IDs
          </p>
          {missing.map((dep) => {
            const key = `active-${group.wsId}-${dep}`
            const state = depSearch.results[key]
            const isOpen = depSearch.open.has(key)
            const added = depSearch.outcomes[key] === 'added'
            return (
              <div key={dep} className="grid gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <code className="font-mono text-sm">{dep}</code>
                  <Button size="xs" variant="outline" className="ms-auto" onClick={() => (isOpen ? void depSearch.search(key, dep, parent, true) : depSearch.toggle(key, dep, parent))} disabled={state?.loading}>
                    {state?.loading ? <Spinner /> : <Search />}
                    Find on the Workshop
                  </Button>
                  {added && <Badge variant="success">Added</Badge>}
                  {depSearch.outcomes[key] === 'error' && <Badge variant="error">Add failed</Badge>}
                </div>
                {isOpen && state && !state.loading && (
                  <div className="grid gap-1.5">
                    {state.error ? (
                      <p className="text-sm text-destructive-foreground">Search failed: {state.error}</p>
                    ) : state.results.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No matches.{' '}
                        {state.searchUrl && (
                          <a href={state.searchUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                            Search on Steam
                          </a>
                        )}
                      </p>
                    ) : (
                      state.results.slice(0, 4).map((hit, index) => (
                        <div key={`${hit.workshopId}-${hit.modId ?? ''}`} className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                              {hit.modName}
                              {(hit.matchType === 'exact-id' || index === 0) && <Badge variant="success">Best match</Badge>}
                            </p>
                            <p className="truncate font-mono text-xs text-muted-foreground">
                              {hit.workshopId}
                              {hit.modId ? ` · ${hit.modId}` : ''} · {hit.source === 'local' ? 'on disk' : 'Steam'}
                            </p>
                          </div>
                          <Button size="xs" variant="outline" onClick={() => void depSearch.add(hit, dep, key)} disabled={depSearch.adding.includes(key) || added}>
                            {depSearch.adding.includes(key) ? <Spinner /> : added ? <Check /> : <Plus />}
                            {added ? 'Added' : 'Add'}
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {duplicates.length > 0 && (
        <div className="grid gap-1.5 rounded-lg border border-warning/30 bg-warning/6 p-3 text-sm">
          <p className="font-medium text-warning-foreground">Another Workshop item has the same ID</p>
          <p className="font-mono text-xs">{duplicates.join(', ')}</p>
        </div>
      )}
      <Button size="sm" variant="ghost" className="justify-start text-destructive-foreground" onClick={onRemove}>
        <Trash2 />
        Take out of the server config
      </Button>
    </Card>
  )
}

/** Every mod ID the server config loads, by Workshop item, with what needs fixing. */
export function ModIdsView({ data, scan, depSearch }: { data: ModsData; scan: ConflictScan; depSearch: DepSearch }) {
  const active = useActiveMods(data, scan)
  const removeMods = useRemoveMods(data)
  const { iniConfig } = data
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim().toLowerCase())
  const [multiOnly, setMultiOnly] = useState(true)
  const [attentionOnly, setAttentionOnly] = useLocalStorageState('zcp:mods:active:attentionOnly', false)
  const [density, setDensity] = useLocalStorageState<'compact' | 'detailed'>('zcp:mods:active:density', 'compact')
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  const [deduping, setDeduping] = useState(false)
  const [dedupeResult, setDedupeResult] = useState<string | null>(null)

  const attentionCount = active.groups.filter((group) => active.attention(group).any).length
  let shown = active.groups
    .map((group) => {
      if (!query || group.wsId.includes(query)) return group
      const mods = group.mods.filter((mod) => mod.id.toLowerCase().includes(query) || mod.name.toLowerCase().includes(query))
      return mods.length ? { ...group, mods } : null
    })
    .filter((group): group is WsGroup => group !== null)
  if (multiOnly) shown = shown.filter((group) => group.mods.length > 1)
  if (attentionOnly) shown = shown.filter((group) => active.attention(group).any)
  const inspected = active.groups.find((group) => group.wsId === inspectedId) ?? shown[0] ?? null

  // Mods= listing the same ID twice; the server loads it once and the rest is noise.
  const duplicateEntries = Object.entries(
    (iniConfig?.modIds ?? []).reduce<Record<string, number>>((counts, id) => ({ ...counts, [id]: (counts[id] || 0) + 1 }), {}),
  ).filter(([, count]) => count > 1)
  const noModIds = (iniConfig?.workshopIds.length ?? 0) > 0 && (iniConfig?.modIds.length ?? 0) === 0

  const dedupe = async () => {
    setDeduping(true)
    setDedupeResult(null)
    try {
      const result = await modsApi.deduplicateModIds()
      setDedupeResult(result.message)
      if (result.removed.length) await data.refreshConfig()
    } catch (error) {
      setDedupeResult(`Error: ${getUserErrorMessage(error, "Couldn't remove the duplicates.")}`)
    } finally {
      setDeduping(false)
    }
  }

  const menu = (group: WsGroup) => (
    <Menu>
      <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`More for ${active.groupLabel(group)}`} onClick={(event) => event.stopPropagation()} />}>
        <MoreHorizontal />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => copyWorkshopId(group.wsId)}>
          <Copy />
          Copy Workshop ID
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => void active.removeFromConfig(group)}>
          <Trash2 />
          Take out of the server config
        </MenuItem>
        <MenuItem variant="destructive" onClick={() => void removeMods([group.wsId])}>
          <Trash2 />
          Remove from the server and stop tracking
        </MenuItem>
      </MenuPopup>
    </Menu>
  )

  return (
    <div className="grid gap-3">
      {duplicateEntries.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Mods= lists some IDs more than once</AlertTitle>
          <AlertDescription>
            {duplicateEntries.map(([id]) => id).join(', ')}
            {dedupeResult && <span className="mt-1 block">{dedupeResult}</span>}
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void dedupe()} disabled={deduping}>
              {deduping ? <Spinner /> : <Wrench />}
              Fix
            </Button>
          </AlertAction>
        </Alert>
      )}
      {noModIds && (
        <Alert variant="info">
          <AlertDescription>
            {plural(iniConfig?.workshopIds.length ?? 0, 'Workshop item')} but no mod IDs. Sync mod IDs in Tools once the server has downloaded them.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="max-w-xs min-w-48 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter by ID or name" aria-label="Filter mod IDs" />
          {search && (
            <InputGroupAddon align="inline-end">
              <Button size="icon-xs" variant="ghost" onClick={() => setSearch('')} aria-label="Clear">
                <X />
              </Button>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Badge variant="outline" title="Mod IDs are the internal names Project Zomboid loads. One Workshop item can have several.">
          {active.enabledCount} of {active.totalCount} IDs on, {plural(active.groups.length, 'Workshop item')}
        </Badge>
        {attentionCount > 0 && (
          <Toggle size="sm" variant="outline" pressed={attentionOnly} onPressedChange={setAttentionOnly} title="Items with a clash, a missing requirement or a duplicate ID">
            <TriangleAlert className="text-destructive-foreground" />
            Needs attention ({attentionCount})
          </Toggle>
        )}
        {active.multiIdCount > 0 && (
          <Toggle size="sm" variant="outline" pressed={multiOnly} onPressedChange={setMultiOnly} title="Items with more than one mod ID. These are usually variants where only some belong together.">
            Several IDs ({active.multiIdCount})
          </Toggle>
        )}
        {active.lastSaved && (
          <span className="flex items-center gap-1 text-sm text-success-foreground">
            <Check className="size-4" />
            Saved
          </span>
        )}
        <Tabs value={density} onValueChange={(value) => setDensity(value as 'compact' | 'detailed')} className="ms-auto">
          <TabsList aria-label="List density">
            <TabsTab value="compact" title="One line per Workshop item">
              Compact
            </TabsTab>
            <TabsTab value="detailed" title="Every mod ID as a toggle in its row">
              Detailed
            </TabsTab>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="overflow-hidden p-0">
          <div className="max-h-[calc(100dvh-22rem)] overflow-y-auto">
            {shown.length === 0 && (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {attentionOnly && attentionCount === 0 ? 'Nothing needs attention.' : query ? `No mod IDs match “${search}”.` : multiOnly ? 'No Workshop item has several IDs.' : 'No mod IDs.'}
              </p>
            )}
            {shown.map((group) => {
              const flags = active.attention(group)
              const isInspected = inspected?.wsId === group.wsId
              const label = active.groupLabel(group)
              const single = group.mods.length === 1
              const mod0 = group.mods[0]
              const clashes = active.clashingPairs(group)
              const requires = Array.from(new Set(group.mods.flatMap((mod) => mod.require ?? [])))
              const missing = requires.filter((dep) => group.mods.some((mod) => active.missingDeps.get(mod.id)?.includes(dep)))
              const dismissedHere = active.ignoredPairs.filter((pair) => group.mods.some((mod) => mod.id === pair.mod_a) && group.mods.some((mod) => mod.id === pair.mod_b))
              const enabledCount = group.mods.filter((mod) => mod.enabled).length
              const showChips = !single && (density === 'detailed' || isInspected)
              const missingBlock =
                missing.length > 0 && group.someEnabled ? (
                  <p className="flex flex-wrap items-center gap-1 text-xs text-destructive-foreground">
                    <TriangleAlert className="size-3" />
                    Needs {missing.join(', ')}, which isn't on.
                  </p>
                ) : null
              return (
                <ModRow
                  key={group.wsId}
                  selected={isInspected}
                  dimmed={!group.someEnabled}
                  onClick={() => setInspectedId(group.wsId)}
                  leading={
                    single ? (
                      <Checkbox checked={mod0.enabled} onCheckedChange={() => void active.toggleMod(mod0, group.wsId)} onClick={(event) => event.stopPropagation()} aria-label={`${mod0.enabled ? 'Turn off' : 'Turn on'} ${mod0.name || mod0.id}`} />
                    ) : (
                      <span className={cn('block size-2 rounded-xs', group.allEnabled ? 'bg-success' : group.someEnabled ? 'bg-success/40' : 'bg-muted-foreground/30')} aria-hidden />
                    )
                  }
                  title={<span className="truncate font-medium">{single ? mod0.name || mod0.id : label}</span>}
                  badges={
                    <>
                      {single && mod0.name !== mod0.id && <code className="font-mono text-xs text-muted-foreground">{mod0.id}</code>}
                      {!single && (
                        <Badge variant={flags.any ? 'error' : group.allEnabled ? 'success' : 'outline'} title="Some items ship IDs that belong together, like add-on packs; others ship alternatives, like Lite and Full. The Workshop page says which.">
                          {enabledCount} of {group.mods.length} on
                        </Badge>
                      )}
                      {single && flags.duplicate && <Badge variant="warning">Duplicate</Badge>}
                    </>
                  }
                  meta={<WorkshopIdChip wsId={group.wsId} />}
                  actions={
                    <>
                      <WorkshopLink wsId={group.wsId} label={label} />
                      {menu(group)}
                    </>
                  }
                  footer={
                    showChips || clashes.length || missingBlock || ((density === 'detailed' || isInspected) && dismissedHere.length) ? (
                      <>
                        {showChips && (
                          <div className="flex flex-wrap gap-1">
                            {group.mods.map((mod) => (
                              <IdChip key={mod.id} active={active} group={group} modId={mod.id} enabled={mod.enabled} onToggle={() => void active.toggleMod(mod, group.wsId)} />
                            ))}
                          </div>
                        )}
                        {clashes.length > 0 && (
                          <p role="alert" className="flex flex-wrap items-center gap-1.5 text-xs text-destructive-foreground">
                            <TriangleAlert className="size-3.5" />
                            Two variants of this mod are on and share files. One overwrites the other, so turn one off.
                            <Button
                              size="xs"
                              variant="ghost"
                              className="ms-auto"
                              onClick={(event) => {
                                event.stopPropagation()
                                for (const [a, b] of clashes) void active.dismissPair(a, b)
                              }}
                              title="Use this when one ID is a shared library the other needs"
                            >
                              Not a conflict
                            </Button>
                          </p>
                        )}
                        {(density === 'detailed' || isInspected) && dismissedHere.length > 0 && clashes.length === 0 && (
                          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            {plural(dismissedHere.length, 'dismissed conflict')}
                            <button
                              type="button"
                              className="underline underline-offset-4 hover:text-foreground"
                              onClick={(event) => {
                                event.stopPropagation()
                                for (const pair of dismissedHere) void active.restorePair(pair.mod_a, pair.mod_b)
                              }}
                            >
                              Restore
                            </button>
                          </p>
                        )}
                        {missingBlock}
                      </>
                    ) : null
                  }
                />
              )
            })}
            {!multiOnly &&
              active.orphaned
                .filter((id) => !query || id.toLowerCase().includes(query))
                .map((id) => (
                  <div key={`orphan-${id}`} className="flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0">
                    <TriangleAlert className="size-3.5 text-warning-foreground" />
                    <code className="min-w-0 flex-1 truncate font-mono">{id}</code>
                    <span className="text-xs text-muted-foreground">Not on disk</span>
                    <Button size="icon-xs" variant="ghost" onClick={() => void active.removeOrphan(id)} aria-label={`Take ${id} out of Mods=`}>
                      <X />
                    </Button>
                  </div>
                ))}
          </div>
        </Card>
        {inspected && <Inspector group={inspected} active={active} depSearch={depSearch} onRemove={() => void active.removeFromConfig(inspected)} />}
      </div>

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 transition-transform group-data-panel-open:rotate-90" />
          Show the raw Mods= line
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <p className="mt-2 rounded-lg bg-muted p-2 font-mono text-xs break-all text-muted-foreground">Mods={iniConfig?.modIds.join(';')}</p>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  )
}
