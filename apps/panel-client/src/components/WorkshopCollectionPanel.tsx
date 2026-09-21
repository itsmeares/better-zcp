import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  Bookmark,
  BookmarkPlus,
  Check,
  CheckCircle2,
  ExternalLink,
  Library,
  Loader2,
  Minus,
  Plus,
  Server,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { modsApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn, copyText } from '@/lib/utils'

type DiffResponse = Awaited<ReturnType<typeof modsApi.collectionDiff>>
type DiffItem = DiffResponse['items'][number]

type FilterKey =
  | 'all'
  | 'missing'
  | 'not-on-server'
  | 'tracked-only'
  | 'synced'
  | 'tracked'
  | 'collection'
  | 'server'
type RowAction =
  | 'track'
  | 'untrack'
  | 'add-server'
  | 'remove-server'
  | 'purge'

function formatAgo(date: Date | null, locale?: string): string {
  if (!date) return 'never'
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return String(seconds) + 's ago'
  if (seconds < 3600) return String(Math.floor(seconds / 60)) + 'm ago'
  return date.toLocaleTimeString(locale)
}

export function WorkshopCollectionPanel() {
  const { toast } = useToast()
  const confirm = useConfirm()
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffCheckedAt, setDiffCheckedAt] = useState<Date | null>(null)
  const [bulkBusy, setBulkBusy] = useState<RowAction | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<DiffItem | null>(null)
  const [filter, setFilter] = useState<FilterKey>('missing')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rowBusy, setRowBusy] = useState<Record<string, RowAction | null>>({})

  const refreshSeqRef = useRef(0)
  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    setDiffLoading(true)
    setDiffError(null)
    try {
      const r = await modsApi.collectionDiff()
      if (seq !== refreshSeqRef.current) return
      setDiff(r)
      setDiffCheckedAt(new Date())
      if (!r.ok && r.error) setDiffError(r.error)
    } catch (err: any) {
      if (seq !== refreshSeqRef.current) return
      setDiffError(getUserErrorMessage(err, 'Failed to read collection'))
    } finally {
      if (seq === refreshSeqRef.current) setDiffLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const collectionId = diff?.collectionId || ''
  const items: DiffItem[] = useMemo(
    () => (diff?.ok && diff.items ? diff.items : []),
    [diff],
  )

  const counts = useMemo(() => {
    let synced = 0,
      toAdd = 0,
      collectionOnly = 0,
      trackedOnly = 0,
      tracked = 0,
      inColl = 0,
      onServer = 0
    for (const it of items) {
      if (it.status === 'synced') synced++
      else if (it.status === 'to-add') toAdd++
      else if (it.status === 'collection-only') collectionOnly++
      else if (it.status === 'tracked-only') trackedOnly++
      if (it.inTracked) tracked++
      if (it.inCollection) inColl++
      if (it.inServer) onServer++
    }
    return {
      synced,
      toAdd,
      collectionOnly,
      trackedOnly,
      tracked,
      inColl,
      onServer,
      total: items.length,
      mismatch: toAdd + collectionOnly + trackedOnly,
    }
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((it) => {
      if (filter === 'missing' && it.status !== 'to-add') return false
      if (filter === 'not-on-server' && it.status !== 'collection-only')
        return false
      if (filter === 'tracked-only' && it.status !== 'tracked-only')
        return false
      if (filter === 'synced' && it.status !== 'synced') return false
      if (filter === 'tracked' && !it.inTracked) return false
      if (filter === 'collection' && !it.inCollection) return false
      if (filter === 'server' && !it.inServer) return false
      if (q) {
        if (
          !it.workshopId.includes(q) &&
          !(it.name || '').toLowerCase().includes(q)
        )
          return false
      }
      return true
    })
  }, [items, filter, search])

  const visibleIds = useMemo(
    () => filtered.map((i) => i.workshopId),
    [filtered],
  )
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someVisibleSelected = visibleIds.some((id) => selected.has(id))
  const selectedItems = useMemo(
    () => filtered.filter((item) => selected.has(item.workshopId)),
    [filtered, selected],
  )
  const canBulkTrack = selectedItems.some((item) => !item.inTracked)
  const canBulkUntrack = selectedItems.some((item) => item.inTracked)
  const canBulkRemoveServer = selectedItems.some((item) => item.inServer)

  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
      else visibleIds.forEach((id) => next.add(id))
      return next
    })
  }
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const clearSelection = () => setSelected(new Set())

  const runRowAction = async (workshopId: string, action: RowAction) => {
    setRowBusy((prev) => ({ ...prev, [workshopId]: action }))
    try {
      if (action === 'track') {
        await modsApi.trackMod(workshopId)
      } else if (action === 'untrack') {
        await modsApi.collectionUntrack(workshopId)
      } else if (action === 'add-server') {
        await modsApi.addToIni(workshopId)
        if (!items.find((item) => item.workshopId === workshopId)?.inTracked) {
          await modsApi.trackMod(workshopId)
        }
        toast({
          title: 'Added to server configuration',
          description:
            'Project Zomboid will download and load this mod on the next server restart.',
        })
      } else if (action === 'remove-server') {
        await modsApi.batchRemove([workshopId])
        toast({
          title: 'Removed from server configuration',
          description: 'Steam collection was left unchanged.',
        })
      } else if (action === 'purge') {
        const item = items.find((it) => it.workshopId === workshopId)
        const r = await modsApi.purgeMod(workshopId, item?.name)
        const done = [
          'removed from the server config',
          r.deletedFromDisk ? 'deleted from disk' : 'no files on disk',
          'untracked and ignored',
        ].filter(Boolean)
        toast({
          title: 'Removed ' + String(r.name || workshopId) + ' everywhere',
          description:
            String(done.join(', ')) + '. Restart the server to apply.',
        })
      }
      await refresh()
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Action failed',
        description: getUserErrorMessage(err, 'Steam rejected the change'),
      })
    } finally {
      setRowBusy((prev) => {
        const next = { ...prev }
        delete next[workshopId]
        return next
      })
    }
  }

  const runBulk = async (action: RowAction) => {
    if (bulkBusy) return
    const targets = filtered.filter((it) => {
      if (!selected.has(it.workshopId)) return false
      if (action === 'track') return !it.inTracked
      if (action === 'untrack') return it.inTracked
      if (action === 'remove-server') return it.inServer
      return false
    })
    if (targets.length === 0) {
      toast({
        title: 'Nothing to do',
        description: 'None of the selected rows need this action.',
      })
      return
    }
    if (action === 'untrack') {
      const ok = await confirm({
        title: 'Untrack ' + String(targets.length) + ' mods?',
        description:
          'This stops the panel watching the mod and adds it to your ignore list. The Steam collection is left unchanged.',
        variant: 'warning',
        confirmLabel: 'Untrack locally',
      })
      if (!ok) return
    }
    if (action === 'remove-server') {
      const ok = await confirm({
        title: 'Remove ' + String(targets.length) + ' mods from the server?',
        description:
          "This removes it from the server's active mod list. It stays tracked here and can be re-added at any time.",
        confirmLabel: 'Remove from server',
      })
      if (!ok) return
      setBulkBusy(action)
      targets.forEach((item) =>
        setRowBusy((prev) => ({ ...prev, [item.workshopId]: action })),
      )
      try {
        await modsApi.batchRemove(targets.map((item) => item.workshopId))
        toast({
          title: 'Removed from server configuration',
            description:
              Number(targets.length) === 1
                ? String(targets.length) +
                  ' mod removed. Steam collection was left unchanged.'
                : String(targets.length) +
                  ' mods removed. Steam collection was left unchanged.',
        })
      } catch (err: any) {
        toast({
          variant: 'destructive',
          title: 'Server removal failed',
          description: getUserErrorMessage(
            err,
            'Unable to update the server configuration.',
          ),
        })
      } finally {
        setBulkBusy(null)
        setRowBusy({})
        await refresh()
        clearSelection()
      }
      return
    }
    setBulkBusy(action)
    let ok = 0
    const errors: Array<{ id: string; error: string }> = []
    for (const it of targets) {
      setRowBusy((prev) => ({ ...prev, [it.workshopId]: action }))
      try {
        if (action === 'track') await modsApi.trackMod(it.workshopId)
        else if (action === 'untrack')
          await modsApi.collectionUntrack(it.workshopId)
        ok++
      } catch (err: any) {
        errors.push({
          id: it.workshopId,
          error: getUserErrorMessage(err, 'Action failed'),
        })
      } finally {
        setRowBusy((prev) => {
          const next = { ...prev }
          delete next[it.workshopId]
          return next
        })
      }
    }
    setBulkBusy(null)
    await refresh()
    clearSelection()
    if (errors.length === 0) {
      toast({
        title: 'Bulk action complete',
        description:
          Number(ok) === 1
            ? String(ok) + ' mod updated.'
            : String(ok) + ' mods updated.',
      })
    } else {
      const uniqueErrors = [...new Set(errors.map((e) => e.error))]
      toast({
        variant: 'destructive',
        title:
          Number(errors.length) === 1
            ? 'Bulk action: ' + String(errors.length) + ' failure'
            : 'Bulk action: ' + String(errors.length) + ' failures',
        description:
          uniqueErrors.length === 1
            ? String(ok) +
              ' succeeded, ' +
              String(errors.length) +
              ' failed — all with the same error: ' +
              String(uniqueErrors[0])
            : String(ok) +
              ' succeeded, ' +
              String(errors.length) +
              ' failed with ' +
              String(uniqueErrors.length) +
              ' different errors. First: ' +
              String(uniqueErrors[0]),
      })
    }
  }

  const noCollectionConfigured = diff !== null && !collectionId

  if (noCollectionConfigured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Library className="w-4 h-4 text-primary" />
            {'Workshop Collection'}
          </CardTitle>
          <CardDescription>
            {'Compare a public Steam Workshop collection with this server.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center text-center py-10 gap-4 border border-dashed border-border/50 rounded-lg bg-muted/10">
            <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center">
              <Library className="w-6 h-6 text-muted-foreground" />
            </div>
            <div className="space-y-1 max-w-md">
              <h3 className="text-sm font-semibold text-foreground">
                {'No collection configured'}
              </h3>
              <p className="text-xs text-muted-foreground">
                {
                  'Add a public Steam Workshop collection ID to compare its mods with this server.'
                }
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to="/settings" search={{ tab: 'mods' }}>
                <SettingsIcon className="w-3.5 h-3.5 me-2" />
                {'Open Settings'}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const inSync = diff?.ok && counts.mismatch === 0
  const syncedRatio =
    counts.total > 0 ? (counts.synced / counts.total) * 100 : 0

  return (
    <Card
      className={cn(
        'overflow-hidden transition-colors',
        counts.mismatch > 0 ? 'border-warning/40' : '',
      )}
    >
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <CardTitle className="flex items-center gap-2 flex-wrap">
              <Library className="w-4 h-4 text-primary shrink-0" />
              <span>{'Workshop Collection'}</span>
              {diff?.title && (
                <a
                  href={
                    collectionId
                      ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${collectionId}`
                      : '#'
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-muted-foreground hover:text-primary inline-flex items-center gap-1 max-w-[280px] truncate"
                  title={diff.title}
                >
                  · {diff.title}
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              )}
            </CardTitle>
            <CardDescription className="flex items-center gap-3 flex-wrap text-xs">
              <span className="font-mono">{collectionId || '—'}</span>
              <span className="text-muted-foreground/60">·</span>
              <span>
                {'Refreshed ' + String(formatAgo(diffCheckedAt, 'en'))}
              </span>
              <span className="text-muted-foreground/60">·</span>
              <span>{'Public read-only collection'}</span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={diffLoading}
              className="h-8 px-2 text-xs"
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the visible label; disables only transiently while re-reading is in flight (the spinning icon is the self-evident why). Triaged 2026-08-27.
              title={'Re-read Steam collection contents'}
            >
              <RefreshCw
                className={cn(
                  'w-3.5 h-3.5 me-1.5',
                  diffLoading && 'animate-spin',
                )}
              />
              {'Refresh'}
            </Button>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground"
            >
              <Link to="/settings" search={{ tab: 'mods' }}>
                <SettingsIcon className="w-3.5 h-3.5 me-1.5" />
                {'Configure'}
              </Link>
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {diffError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1">{diffError}</div>
          </div>
        )}

        <div
          className={cn(
            'rounded-lg border px-3 py-3',
            inSync
              ? 'border-success/30 bg-success/[0.04]'
              : 'border-warning/35 bg-warning/[0.045]',
          )}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              {inSync ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              ) : (
                <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
              )}
              <div className="min-w-0">
                <p
                  className={cn(
                    'text-sm font-semibold',
                    inSync ? 'text-success' : 'text-warning',
                  )}
                >
                  {inSync
                    ? 'Collection matches the server'
                    : Number(counts.mismatch) === 1
                      ? String(counts.mismatch) + ' difference to review'
                      : String(counts.mismatch) + ' differences to review'}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {String(counts.toAdd) +
                    ' on the server but not in the collection; ' +
                    String(counts.collectionOnly) +
                    ' in the collection but not on the server'}
                  {counts.trackedOnly > 0
                    ? '; ' +
                      String(counts.trackedOnly) +
                      ' tracked but in neither'
                    : ''}
                  .
                </p>
              </div>
            </div>
            <div className="min-w-[12rem] space-y-1.5">
              <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                <span>{String(Math.round(syncedRatio)) + '%'}</span>
                {!inSync && (
                  <span>
                    {Number(counts.mismatch) === 1
                      ? String(counts.mismatch) + ' to review'
                      : String(counts.mismatch) + ' to review'}
                  </span>
                )}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-border/40">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-500 ease-out',
                    inSync ? 'bg-success' : 'bg-warning',
                  )}
                  style={{ width: `${syncedRatio}%` }}
                />
              </div>
            </div>
          </div>
          <details className="group/collection-details mt-2 border-t border-border/25 pt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
              <span className="transition-transform group-open/collection-details:rotate-90">
                <Plus className="h-3 w-3" />
              </span>
              {'Show collection counts'}
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile
                label={'On the server'}
                value={counts.onServer}
                icon={<Server className="w-3.5 h-3.5" />}
                accent="primary"
                onClick={() => setFilter('server')}
              />
              <StatTile
                label={'In Steam collection'}
                value={counts.inColl}
                icon={<Library className="w-3.5 h-3.5" />}
                accent="primary"
                onClick={() => setFilter('collection')}
              />
              <StatTile
                label={'Missing from collection'}
                value={counts.toAdd}
                icon={<Plus className="w-3.5 h-3.5" />}
                accent={counts.toAdd > 0 ? 'warning' : 'muted'}
                onClick={
                  counts.toAdd > 0 ? () => setFilter('missing') : undefined
                }
              />
              <StatTile
                label={'Not on the server'}
                value={counts.collectionOnly}
                icon={<Library className="w-3.5 h-3.5" />}
                accent={counts.collectionOnly > 0 ? 'primary' : 'muted'}
                onClick={
                  counts.collectionOnly > 0
                    ? () => setFilter('not-on-server')
                    : undefined
                }
              />
            </div>
          </details>
        </div>

        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border/55 bg-muted/30 p-0.5 text-[11px] font-medium">
            {(
              [
                ['missing', 'Missing from collection', counts.toAdd],
                ['not-on-server', 'Not on server', counts.collectionOnly],
                ...(counts.trackedOnly > 0
                  ? [
                      ['tracked-only', 'Tracked only', counts.trackedOnly] as [
                        FilterKey,
                        string,
                        number,
                      ],
                    ]
                  : []),
                ['synced', 'In sync', counts.synced],
                ['all', 'All', counts.total],
              ] as Array<[FilterKey, string, number]>
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  'shrink-0 px-2 py-1 rounded-sm transition-colors',
                  filter === key
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                )}
              >
                {label} <span className="opacity-70">({count})</span>
              </button>
            ))}
          </div>

          <div className="relative w-full lg:w-64">
            <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={'Filter by name or ID…'}
              className="h-8 w-full ps-7 pe-7 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={'Clear search'}
              >
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs animate-in fade-in slide-in-from-top-1">
            <span className="font-medium text-foreground">
              {String(selected.size) + ' selected'}
            </span>
            <span className="text-muted-foreground/60">·</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => runBulk('track')}
              disabled={!!bulkBusy || !canBulkTrack}
            >
              {bulkBusy === 'track' ? (
                <Loader2 className="w-3 h-3 me-1 animate-spin" />
              ) : (
                <BookmarkPlus className="w-3 h-3 me-1" />
              )}
              {'Track locally'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground"
              onClick={() => runBulk('untrack')}
              disabled={!!bulkBusy || !canBulkUntrack}
            >
              {bulkBusy === 'untrack' ? (
                <Loader2 className="w-3 h-3 me-1 animate-spin" />
              ) : (
                <Bookmark className="w-3 h-3 me-1" />
              )}
              {'Untrack'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => runBulk('remove-server')}
              disabled={!!bulkBusy || !canBulkRemoveServer}
              // eslint-disable-next-line local/no-dead-disabled-title -- hint describing the button's purpose/use-case ("after they were removed from Steam"), not an instruction tied to canBulkRemoveServer or bulkBusy -- doesn't tell the user what to do to enable it. Read as pure hint, not a disabled-reason. Triaged 2026-08-27.
              title={'Remove selected mods from the server configuration'}
            >
              {bulkBusy === 'remove-server' ? (
                <Loader2 className="w-3 h-3 me-1 animate-spin" />
              ) : (
                <Minus className="w-3 h-3 me-1" />
              )}
              {'Remove from server'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] ms-auto"
              onClick={clearSelection}
            >
              <X className="w-3 h-3 me-1" />
              {'Clear'}
            </Button>
          </div>
        )}

        <div className="rounded-md border border-border/60 overflow-hidden">
          <div className="max-h-[520px] overflow-auto">
            {diffLoading && !diff ? (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin inline me-2" />
                {'Reading collection from Steam…'}
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground space-y-2">
                {inSync && filter === 'missing' ? (
                  <>
                    <CheckCircle2 className="w-6 h-6 text-success mx-auto" />
                    <div className="font-medium text-foreground">
                      {"Everything's in sync"}
                    </div>
                    <div>
                      {
                        'The Steam collection matches the mods on the server exactly.'
                      }
                    </div>
                  </>
                ) : search ? (
                  <div>{'No mods match your search.'}</div>
                ) : (
                  <div>{'Nothing in this filter.'}</div>
                )}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                  <tr className="text-start text-muted-foreground border-b border-border/50">
                    <th className="font-medium px-3 py-2 w-[36px]">
                      <Checkbox
                        checked={
                          allVisibleSelected
                            ? true
                            : someVisibleSelected
                              ? 'indeterminate'
                              : false
                        }
                        onCheckedChange={toggleSelectAllVisible}
                        aria-label={'Select all visible'}
                      />
                    </th>
                    <th className="font-medium px-3 py-2 w-[150px]">
                      {'Status'}
                    </th>
                    <th className="font-medium px-3 py-2">{'Mod'}</th>
                    <th className="font-medium px-3 py-2 w-[320px] text-end">
                      {'Actions'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it) => (
                    <Row
                      key={it.workshopId}
                      item={it}
                      selected={selected.has(it.workshopId)}
                      onToggleSelect={() => toggleOne(it.workshopId)}
                      busy={rowBusy[it.workshopId] || null}
                      onAction={(action) => {
                        if (action === 'purge') {
                          setPurgeTarget(it)
                          return
                        }
                        if (action === 'untrack') {
                          confirm({
                            title: 'Untrack this mod?',
                            description:
                              'This stops the panel watching the mod and adds it to your ignore list. The Steam collection is left unchanged.',
                            variant: 'warning',
                            confirmLabel: 'Untrack locally',
                          }).then((ok) => {
                            if (ok) runRowAction(it.workshopId, action)
                          })
                          return
                        }
                        if (action === 'remove-server') {
                          confirm({
                            title: 'Remove this mod from the server?',
                            description:
                              "This removes it from the server's active mod list. It stays tracked here and can be re-added at any time.",
                            confirmLabel: 'Remove from server',
                          }).then((ok) => {
                            if (ok) runRowAction(it.workshopId, action)
                          })
                          return
                        }
                        runRowAction(it.workshopId, action)
                      }}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-border/40 bg-muted/20 text-[10px] text-muted-foreground">
            <span>
              {String(filtered.length) +
                ' of ' +
                String(counts.total) +
                ' shown'}
              {selected.size > 0 && ' · ' + String(selected.size) + ' selected'}
            </span>
            <span className="hidden md:inline">
              {
                'Click a mod name to open it on Steam · per-row actions apply immediately'
              }
            </span>
          </div>
        </div>
        <AlertDialog
          open={!!purgeTarget}
          onOpenChange={(open) => !open && setPurgeTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {'Remove ' +
                  String(purgeTarget?.name || purgeTarget?.workshopId) +
                  ' everywhere?'}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>{'This removes the mod from the server and panel data:'}</p>
                  <ul className="list-disc ps-5 space-y-0.5">
                    <li>
                      <>
                        {'the server config ('}
                        <code>{'WorkshopItems'}</code>
                        {', '}
                        <code>{'Mods'}</code>
                        {', '}
                        <code>{'Map'}</code>
                        {')'}
                      </>
                    </li>
                    <li>{'the downloaded files on disk'}</li>
                    <li>{"the panel's tracked list"}</li>
                  </ul>
                  <p>
                    {
                      "It is then added to the ignore list so a later scan can't quietly bring it back. Restart the server to apply."
                    }
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{'Cancel'}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  const target = purgeTarget
                  setPurgeTarget(null)
                  if (target) runRowAction(target.workshopId, 'purge')
                }}
              >
                {'Remove everywhere'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

type StatAccent = 'primary' | 'warning' | 'destructive' | 'muted'

function StatTile({
  label,
  value,
  icon,
  accent,
  onClick,
}: {
  label: string
  value: number
  icon: React.ReactNode
  accent: StatAccent
  onClick?: () => void
}) {
  const accentCls: Record<StatAccent, string> = {
    primary: 'border-primary/30 bg-primary/5 text-primary',
    warning: 'border-warning/40 bg-warning/5 text-warning',
    destructive: 'border-destructive/40 bg-destructive/5 text-destructive',
    muted: 'border-border/50 bg-muted/10 text-muted-foreground',
  }
  const interactive = !!onClick
  const Tag: any = interactive ? 'button' : 'div'
  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'group rounded-md border px-3 py-2.5 text-start transition-colors',
        accentCls[accent],
        interactive && 'hover:bg-current/10 cursor-pointer',
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-80">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="text-2xl font-semibold tabular-nums mt-1 text-foreground">
        {value}
      </div>
    </Tag>
  )
}

function Row({
  item,
  selected,
  onToggleSelect,
  busy,
  onAction,
}: {
  item: DiffItem
  selected: boolean
  onToggleSelect: () => void
  busy: RowAction | null
  onAction: (action: RowAction) => void
}) {
  const { toast } = useToast()
  const statusMeta =
    item.status === 'synced'
      ? {
          label: 'In sync',
          cls: 'text-success border-success/40 bg-success/10',
          icon: <Check className="w-3 h-3" />,
        }
      : item.status === 'to-add'
        ? {
            label: 'Missing from collection',
            cls: 'text-warning border-warning/40 bg-warning/10',
            icon: <Plus className="w-3 h-3" />,
          }
        : item.status === 'collection-only'
          ? {
              label: 'Not on server',
              cls: 'text-primary border-primary/40 bg-primary/10',
              icon: <Library className="w-3 h-3" />,
            }
          : {
              label: 'Tracked only',
              cls: 'text-muted-foreground border-border bg-muted/40',
              icon: <Bookmark className="w-3 h-3" />,
            }

  return (
    <tr
      className={cn(
        'border-b border-border/30 last:border-b-0 hover:bg-muted/30 transition-colors',
        selected && 'bg-primary/5',
      )}
    >
      <td className="px-3 py-2 align-top">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          aria-label={'Select ' + String(item.name || item.workshopId)}
        />
      </td>
      <td className="px-3 py-2 align-top">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium',
            statusMeta.cls,
          )}
        >
          {statusMeta.icon}
          {statusMeta.label}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-col min-w-0">
          <a
            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.workshopId}`}
            target="_blank"
            rel="noreferrer"
            className="truncate text-foreground hover:text-primary hover:underline underline-offset-2 font-medium inline-flex items-center gap-1"
            title={item.name || item.workshopId}
          >
            {item.name || (
              <span className="font-mono text-muted-foreground">
                {item.workshopId}
              </span>
            )}
            <ExternalLink className="w-2.5 h-2.5 opacity-50 shrink-0" />
          </a>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/80 font-mono">
            <span>{item.workshopId}</span>
            <span>·</span>
            <span className={item.inTracked ? '' : 'opacity-50'}>
              {item.inTracked ? 'tracked' : 'not tracked'}
            </span>
            <span>·</span>
            <span className={item.inCollection ? '' : 'opacity-50'}>
              {item.inCollection ? 'in collection' : 'not in collection'}
            </span>
            <span>·</span>
            <span className={item.inServer ? '' : 'opacity-50'}>
              {item.inServer ? 'on server' : 'not on server'}
            </span>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex items-center justify-end gap-1">
          {item.inServer ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onAction('remove-server')}
              disabled={!!busy}
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
              title={'Remove this mod from the server configuration'}
            >
              {busy === 'remove-server' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Server className="w-3 h-3" />
              )}
              <span className="ms-1 hidden sm:inline">
                {'Remove from server'}
              </span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
              onClick={() => onAction('add-server')}
              disabled={!!busy}
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
              title={'Add this Workshop mod to the server configuration'}
            >
              {busy === 'add-server' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Server className="w-3 h-3" />
              )}
              <span className="ms-1 hidden sm:inline">{'Add to server'}</span>
            </Button>
          )}
          {item.inTracked ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => onAction('untrack')}
              disabled={!!busy}
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
              title={'Untrack locally; leave the Steam collection unchanged'}
            >
              {busy === 'untrack' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Bookmark className="w-3 h-3" />
              )}
              <span className="ms-1 hidden sm:inline">{'Untrack'}</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10"
              onClick={() => onAction('track')}
              disabled={!!busy}
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
              title={'Track locally'}
            >
              {busy === 'track' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <BookmarkPlus className="w-3 h-3" />
              )}
              <span className="ms-1 hidden sm:inline">{'Track'}</span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                disabled={!!busy}
                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint ("More"), disables only transiently while an action is in flight. Triaged 2026-08-27.
                title={'More'}
              >
                <span className="text-base leading-none">⋯</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">
                {item.workshopId}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a
                  href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.workshopId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="cursor-pointer"
                >
                  <ExternalLink className="w-3.5 h-3.5 me-2" />
                  {'Open on Steam'}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  copyText(item.workshopId).then((ok) => {
                    toast(
                      ok
                        ? { title: 'Copied', description: item.workshopId }
                        : { title: 'Copy failed', variant: 'destructive' },
                    )
                  })
                }}
              >
                <Library className="w-3.5 h-3.5 me-2" />
                {'Copy workshop ID'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onAction('purge')}
              >
                <Trash2 className="w-3.5 h-3.5 me-2" />
                {'Remove everywhere'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  )
}
