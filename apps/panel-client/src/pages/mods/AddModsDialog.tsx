import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, ExternalLink, Map as MapIcon, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { modsApi } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'
import { HelpTip } from '@/components/HelpTip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { notify, parseSteamCommunityUrl, parseWorkshopId, plural, workshopUrl } from './modsShared'
import { syncModIds } from './ToolsView'
import type { ModsData } from './useModsData'

export type AddTab = 'item' | 'collection' | 'downloads'

interface Discovered {
  workshopId: string
  name: string
  modIds: string[]
  isMap: boolean
  mapFolders: string[]
  isDownloaded: boolean
  alreadyConfigured: string[]
  isAlreadyAdded: boolean
}

interface CollectionMod {
  workshopId: string
  name: string
  isMap: boolean
  modId?: string
  mapFolder?: string
  selected?: boolean
}

/** Add one Workshop item. Its mod IDs are read from mod.info as soon as a valid ID is typed. */
function WorkshopItemTab({ data, onDone }: { data: ModsData; onDone: () => void }) {
  const { iniConfig } = data
  const [input, setInput] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [found, setFound] = useState<Discovered | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const lastId = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      abort.current?.abort()
    },
    [],
  )

  const discover = useCallback(
    async (workshopId: string) => {
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      if (iniConfig?.workshopIds?.includes(workshopId)) {
        notify('Already added', 'This Workshop item is already in the server config.')
        return
      }
      setDiscovering(true)
      setFound(null)
      setChosen(new Set())
      try {
        const result = await modsApi.discoverModIds(workshopId, undefined, { signal: controller.signal })
        const seen = new Set<string>()
        const modIds = (result.modIds as string[]).filter((id) => !seen.has(id.toLowerCase()) && !!seen.add(id.toLowerCase()))
        const alreadyConfigured = modIds.filter((id) => iniConfig?.modIds?.includes(id))
        setFound({ ...result, modIds, alreadyConfigured, isAlreadyAdded: !!iniConfig?.workshopIds?.includes(workshopId) })
        setChosen(new Set(modIds.filter((id) => !alreadyConfigured.includes(id))))
        if (modIds.length === 0) {
          notify('No mod IDs found', result.isDownloaded ? "It's downloaded, but has no mod.info files." : "It isn't downloaded yet. Add it anyway, then sync once the server downloads it.")
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        notify("Couldn't read the mod", getUserErrorMessage(error, 'Check the Workshop ID and try again.'), 'error')
      } finally {
        setDiscovering(false)
      }
    },
    [iniConfig?.modIds, iniConfig?.workshopIds],
  )

  const onInput = (value: string) => {
    setInput(value)
    if (timer.current) clearTimeout(timer.current)
    const id = parseWorkshopId(value)
    if (id && id !== lastId.current) {
      lastId.current = id
      timer.current = setTimeout(() => void discover(id), 200)
    }
  }

  const add = async () => {
    if (!found || data.busyRef.current) return
    data.busyRef.current = true
    setAdding(true)
    try {
      const ids = Array.from(chosen)
      await modsApi.trackMod(found.workshopId)
      const result = await modsApi.addModAdvanced(found.workshopId, ids.length ? ids : undefined, ids.length === 0)
      if (result.addedModIds.length > 0) {
        const maps = result.mapFoldersAdded.length ? ` ${plural(result.mapFoldersAdded.length, 'Map', 'Maps')}: ${result.mapFoldersAdded.join(', ')}.` : ''
        notify('Added to the server config', `${result.addedModIds.join(', ')}.${maps} Restart the server to load it.`, 'success')
      } else if (result.workshopAlreadyExisted) {
        notify('Already in the config')
      } else {
        notify('Workshop ID added', 'Its mod IDs get added once the server downloads the files and you sync.', 'success')
      }
      void data.fetchData()
      onDone()
    } catch (error) {
      notify("Couldn't add the mod", getUserErrorMessage(error, 'Try again.'), 'error')
    } finally {
      setAdding(false)
      data.busyRef.current = false
    }
  }

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      <DialogPanel className="grid gap-4">
        <Field>
          <FieldLabel>Workshop link or ID</FieldLabel>
          <div className="flex w-full gap-2">
            <Input
              className="min-w-0 flex-1 font-mono"
              value={input}
              onChange={(event) => onInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || discovering) return
                const id = parseWorkshopId(input)
                if (id) void discover(id)
                else notify('Not a Workshop link', 'Paste a Workshop link or a number like 3616536783.', 'error')
              }}
              placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…"
              maxLength={200}
              autoFocus
            />
            <Button
              variant="outline"
              disabled={discovering || !input.trim()}
              onClick={() => {
                const id = parseWorkshopId(input)
                if (id) void discover(id)
                else notify('Not a Workshop link', 'Paste a Workshop link or a number like 3616536783.', 'error')
              }}
            >
              {discovering ? <Spinner /> : <Search />}
              Look up
            </Button>
          </div>
        </Field>

        {discovering && <Skeleton className="h-28" />}

        {found && !discovering && (
          <div className="grid gap-3 rounded-xl border p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={found.name}>
                  {found.name}
                </p>
                <a href={workshopUrl(found.workshopId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
                  {found.workshopId}
                  <ExternalLink className="size-3" />
                </a>
              </div>
              {found.isMap && (
                <Badge variant="secondary">
                  <MapIcon />
                  Map
                </Badge>
              )}
              <Badge variant={found.isDownloaded ? 'success' : 'warning'}>
                {found.isDownloaded ? <CheckCircle2 /> : <Download />}
                {found.isDownloaded ? 'Downloaded' : 'Not downloaded'}
              </Badge>
            </div>
            {found.isAlreadyAdded && <p className="text-sm text-muted-foreground">This Workshop item is already in the server config.</p>}
            {found.modIds.length > 0 ? (
              <div className="grid gap-2">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {found.modIds.length > 1 ? `Mod IDs, ${chosen.size} of ${found.modIds.length} picked` : 'Mod ID'}
                  <HelpTip label="Mod IDs">
                    A Workshop item can hold several mod IDs, the folder names in its mod.info. Only the picked ones go into the config; leave one out and that part of the mod won't load.
                  </HelpTip>
                  {found.modIds.length > 1 && (
                    <Button size="xs" variant="ghost" className="ms-auto" onClick={() => setChosen(chosen.size === found.modIds.length ? new Set() : new Set(found.modIds))}>
                      {chosen.size === found.modIds.length ? 'Pick none' : 'Pick all'}
                    </Button>
                  )}
                </p>
                <div className="max-h-56 overflow-y-auto rounded-lg border">
                  {found.modIds.map((id) => (
                    <label key={id} className={cn('flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 last:border-b-0 hover:bg-accent', chosen.has(id) && 'bg-accent/50')}>
                      <Checkbox checked={chosen.has(id)} onCheckedChange={() => toggle(id)} />
                      <code className="min-w-0 flex-1 truncate font-mono text-sm">{id}</code>
                      {found.alreadyConfigured.includes(id) && <Badge variant="outline">Already in</Badge>}
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <Alert variant="warning">
                <TriangleAlert />
                <AlertTitle>{found.isDownloaded ? 'No mod.info found' : 'Not downloaded yet'}</AlertTitle>
                <AlertDescription>{found.isDownloaded ? 'This mod may use an unusual layout.' : 'Add the Workshop ID now, then sync after the server downloads it.'}</AlertDescription>
              </Alert>
            )}
            {found.mapFolders.length > 0 && (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Map folders added:</span> {found.mapFolders.join(', ')}
              </p>
            )}
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button onClick={() => void add()} disabled={adding || !found || discovering}>
          {adding && <Spinner />}
          {!found ? 'Look it up first' : found.modIds.length === 0 || chosen.size === 0 ? 'Add the Workshop ID only' : `Add ${plural(chosen.size, 'mod ID')}`}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Adds the mods from a Steam Workshop collection, once. Collection sync keeps one mirrored. */
function CollectionTab({ data, onDone }: { data: ModsData; onDone: () => void }) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [list, setList] = useState<CollectionMod[]>([])
  const [advanced, setAdvanced] = useState(false)
  const [adding, setAdding] = useState(false)
  const picked = list.filter((mod) => mod.selected)

  const load = async () => {
    const trimmed = url.trim()
    if (!/^\d{1,15}$/.test(trimmed) && !parseSteamCommunityUrl(trimmed)) {
      notify('Not a collection link', 'Paste a Steam Workshop collection link or its number.', 'error')
      return
    }
    setLoading(true)
    try {
      const result = await modsApi.importCollection(trimmed)
      const existing = new Set(data.iniConfig?.workshopIds ?? [])
      const found: CollectionMod[] = (result.mods || []).map((mod: CollectionMod) => ({ ...mod, selected: !existing.has(mod.workshopId), modId: '', mapFolder: undefined }))
      setList(found)
      setLoaded(true)
      const subCollections = (result.subCollectionIds || []).length
      if (found.length === 0) {
        notify(
          'No mods found',
          subCollections ? `Every item is itself a collection (${subCollections}). Steam can't add those as mods; import each one instead.` : 'The collection looks empty. Check the link.',
          'error',
        )
      } else if (subCollections) {
        notify(`${plural(found.length, 'mod')} found`, `${subCollections} nested collections were skipped.`)
      }
    } catch (error) {
      notify("Couldn't read the collection", getUserErrorMessage(error, 'Check the link and try again.'), 'error')
    } finally {
      setLoading(false)
    }
  }

  const add = async () => {
    if (!picked.length) return
    setAdding(true)
    const results = await Promise.allSettled(
      picked.map((mod) => modsApi.addModAdvanced(mod.workshopId, mod.modId ? [mod.modId] : undefined, !mod.modId, mod.name, mod.isMap ? mod.mapFolder : undefined)),
    )
    results.forEach((result, index) => result.status === 'rejected' && reportClientWarning(`Failed to add mod ${picked[index].workshopId}.`, result.reason))
    const failed = results.filter((result) => result.status === 'rejected').length
    notify(`${plural(picked.length - failed, 'mod')} added to the server config`, failed ? `${failed} failed. The browser console has details.` : 'Restart the server to load them.', failed ? 'error' : 'success')
    setAdding(false)
    void data.fetchData()
    onDone()
  }

  const update = (workshopId: string, patch: Partial<CollectionMod>) => setList((prev) => prev.map((mod) => (mod.workshopId === workshopId ? { ...mod, ...patch } : mod)))

  return (
    <>
      <DialogPanel className="grid gap-4">
        <Field>
          <FieldLabel>Collection link or ID</FieldLabel>
          <div className="flex w-full gap-2">
            <Input className="min-w-0 flex-1" value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void load()} placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…" maxLength={200} />
            <Button variant="outline" onClick={() => void load()} disabled={loading || !url.trim()}>
              {loading ? <Spinner /> : <Download />}
              Load
            </Button>
          </div>
          <FieldDescription>A collection's own link, not a single mod's. This adds its mods once; Collection sync keeps a server mirrored to one.</FieldDescription>
        </Field>
        {loaded && list.length > 0 && (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{plural(list.length, 'mod')} found</span>
              <Button size="xs" variant="ghost" className="ms-auto" onClick={() => setAdvanced(!advanced)}>
                {advanced ? 'Hide IDs and maps' : 'Edit IDs and maps'}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setList((prev) => prev.map((mod) => ({ ...mod, selected: picked.length !== list.length })))}>
                {picked.length === list.length ? 'Pick none' : 'Pick all'}
              </Button>
            </div>
            <div className="max-h-80 overflow-y-auto rounded-lg border">
              {list.map((mod) => {
                const installed = data.iniConfig?.workshopIds?.includes(mod.workshopId)
                return (
                  <div key={mod.workshopId} className={cn('grid gap-2 border-b px-3 py-2 last:border-b-0', mod.selected && 'bg-accent/50')}>
                    <div className="flex items-center gap-2">
                      <Checkbox checked={!!mod.selected} onCheckedChange={() => update(mod.workshopId, { selected: !mod.selected })} aria-label={`Pick ${mod.name}`} />
                      <span className="min-w-0 flex-1 truncate text-sm">{mod.name}</span>
                      {installed && <Badge variant="outline">Already in</Badge>}
                      {mod.isMap && (
                        <Badge variant="secondary">
                          <MapIcon />
                          Map
                        </Badge>
                      )}
                      <a href={workshopUrl(mod.workshopId)} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground" aria-label={`Open ${mod.name} on the Workshop`}>
                        <ExternalLink className="size-4" />
                      </a>
                    </div>
                    {mod.selected && advanced && (
                      <div className="grid gap-2 ps-6 sm:grid-cols-2">
                        <Input value={mod.modId || ''} onChange={(event) => update(mod.workshopId, { modId: event.target.value })} placeholder="Mod ID (blank adds all)" maxLength={200} aria-label={`${mod.name} mod ID`} />
                        {mod.isMap && <Input value={mod.mapFolder || ''} onChange={(event) => update(mod.workshopId, { mapFolder: event.target.value })} placeholder="Map folder" maxLength={200} aria-label={`${mod.name} map folder`} />}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {loaded && list.length === 0 && !loading && <p className="text-sm text-muted-foreground">No mods in this collection.</p>}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button onClick={() => void add()} disabled={adding || picked.length === 0}>
          {adding && <Spinner />}
          Add {plural(picked.length, 'mod')}
        </Button>
      </DialogFooter>
    </>
  )
}

/** One dialog for every way to add mods: a Workshop item, a collection, or what's already downloaded. */
export function AddModsDialog({ data, open, tab, onOpenChange, onTabChange }: { data: ModsData; open: boolean; tab: AddTab; onOpenChange: (open: boolean) => void; onTabChange: (tab: AddTab) => void }) {
  const [syncing, setSyncing] = useState(false)
  const close = () => onOpenChange(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add mods</DialogTitle>
          <DialogDescription>Mods go into the server config. The server downloads them on its next start.</DialogDescription>
          <Tabs value={tab} onValueChange={(value) => onTabChange(value as AddTab)} className="mt-2">
            <TabsList className="w-full">
              <TabsTab value="item">Workshop item</TabsTab>
              <TabsTab value="collection">Collection</TabsTab>
              <TabsTab value="downloads">From downloads</TabsTab>
            </TabsList>
          </Tabs>
        </DialogHeader>
        {open && tab === 'item' && <WorkshopItemTab data={data} onDone={close} />}
        {open && tab === 'collection' && <CollectionTab data={data} onDone={close} />}
        {tab === 'downloads' && (
          <>
            <DialogPanel>
              <p className="text-sm text-muted-foreground">Reads mod.info in every mod already downloaded to the Workshop folder and adds the mod IDs that aren't in Mods= yet.</p>
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
              <Button
                disabled={syncing}
                onClick={async () => {
                  setSyncing(true)
                  await syncModIds(data)
                  setSyncing(false)
                  close()
                }}
              >
                {syncing ? <Spinner /> : <RefreshCw />}
                Sync mod IDs
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  )
}
