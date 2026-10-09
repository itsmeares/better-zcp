import { useCallback, useEffect, useState } from 'react'
import { Package, PlusCircle, RefreshCw, Trash2 } from 'lucide-react'
import { modsApi } from '@/lib/api'
import { isDemoMode } from '@/lib/demo'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { reportClientError } from '@/lib/client-errors'
import { useConfirm } from '@/contexts/ConfirmContext'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { ModRow, WorkshopIdChip, WorkshopLink, WorkshopThumb } from './ModRow'
import { notify, plural } from './modsShared'
import type { ModsData } from './useModsData'

const BATCH_DISK = '__disk'
const BATCH_IGNORED = '__ignored'

/** Mods the server doesn't load: tracked but missing from the config, downloaded but off, or ignored by sync. */
export function NotLoadedView({ data }: { data: ModsData }) {
  const { mods, iniConfig, ignoredMods, loading } = data
  const confirm = useConfirm()
  const demo = isDemoMode()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [disk, setDisk] = useState<Array<{ workshop_id: string; name: string }> | null>(null)
  const [diskLoading, setDiskLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const configured = new Set(iniConfig?.workshopIds ?? [])
  const deactivated = iniConfig ? mods.filter((mod) => !configured.has(mod.workshop_id)) : []
  const deactivatedIds = deactivated.map((mod) => mod.workshop_id)
  const chosen = deactivatedIds.filter((id) => selected.has(id))
  const genericNames = deactivated.filter((mod) => !mod.name || /^Workshop Mod /i.test(mod.name))

  const loadDisk = useCallback(async () => {
    setDiskLoading(true)
    try {
      setDisk((await modsApi.listDiskOnly()).mods || [])
    } catch (error) {
      reportClientError('Failed to fetch disabled mods.', error)
      notify("Couldn't scan the Workshop folder", 'Try again.', 'error')
    } finally {
      setDiskLoading(false)
    }
  }, [])
  useEffect(() => {
    void loadDisk()
  }, [loadDisk])

  const refreshAll = () => Promise.allSettled([data.fetchData(), loadDisk()])

  const reEnable = (ids: string[]) =>
    data.runExclusive("Couldn't re-enable", async () => {
      let ok = 0
      let failed = 0
      for (const id of ids) {
        try {
          await modsApi.addToIni(id)
          ok++
        } catch {
          failed++
        }
      }
      notify(failed ? 'Partly re-enabled' : 'Re-enabled', `${plural(ok, 'mod')} back in the server config${failed ? `, ${failed} failed` : ''}. Restart the server to load them.`, failed ? 'error' : 'success')
      setSelected(new Set())
      void data.fetchData()
    })

  const untrack = async () => {
    const ids = chosen.length ? chosen : deactivatedIds
    const confirmed = await confirm({
      title: 'Stop tracking these mods?',
      description: `${plural(ids.length, 'mod')} ${chosen.length ? 'selected' : 'in this list'} come off the panel's list. The Workshop files stay on disk, and you can add them back later.`,
      confirmLabel: 'Stop tracking',
    })
    if (!confirmed) return
    await data.runExclusive("Couldn't stop tracking", async () => {
      const result = (await modsApi.batchRemove(ids)) as { total?: number; dbFailed?: number; dbRemoved?: number; error?: string }
      if (result.error) throw new Error(result.error)
      notify((result.dbFailed ?? 0) > 0 ? 'Partly done' : `${plural(result.total ?? ids.length, 'mod')} untracked`, undefined, (result.dbFailed ?? 0) > 0 ? 'error' : 'success')
      setSelected(new Set())
      void data.fetchData()
    })
  }

  const refreshNames = () =>
    data.runExclusive("Couldn't look up names", async () => {
      const result = await modsApi.refreshNames(genericNames.map((mod) => mod.workshop_id))
      const total = result.totalResolved ?? 0
      notify(
        total > 0 ? `Found ${plural(total, 'name')}` : 'No new names found',
        total > 0
          ? `${result.diskResolved} from disk, ${result.steamResolved} from Steam${result.unresolved ? `. ${result.unresolved} still unknown, probably deleted or private` : ''}.`
          : `Checked ${plural(result.checked, 'placeholder name')}. The mods may be deleted or private on Steam.`,
        total > 0 ? 'success' : undefined,
      )
      if (total > 0) void data.fetchData()
    })

  const enableDiskMod = async (workshopId: string) => {
    if (busyId) return
    setBusyId(workshopId)
    try {
      const result = await modsApi.enableDiskMod(workshopId)
      notify('Mod enabled', `Added to the server config (${plural(result.modIdsAdded, 'mod ID')}). Restart the server to load it.`, 'success')
      await refreshAll()
    } catch (error) {
      notify("Couldn't enable", getUserErrorMessage(error, 'Try again.'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const deleteFromDisk = async (workshopId: string, name?: string | null) => {
    if (busyId) return
    const confirmed = await confirm({
      title: 'Delete this mod from disk?',
      description: `${name ? `"${name}" (${workshopId})` : workshopId} loses its Workshop folder and comes out of the server config. There is no undo. Steam downloads it again on the next start if WorkshopItems= still lists it.`,
      confirmLabel: 'Delete from disk',
      destructive: true,
    })
    if (!confirmed) return
    setBusyId(workshopId)
    try {
      const result = await modsApi.deleteDiskMod(workshopId)
      notify('Deleted', result.deletedFromDisk ? `Removed from disk, ${plural(result.modIdsStripped, 'mod ID')} taken out of the config.` : 'The folder was already gone; the config is cleaned up.', 'success')
      await refreshAll()
    } catch (error) {
      notify("Couldn't delete", getUserErrorMessage(error, 'Try again.'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const deleteMany = async (list: Array<{ workshop_id: string; name: string | null }>, batch: string, extra: string) => {
    if (busyId || list.length === 0) return
    const confirmed = await confirm({
      title: `Delete ${plural(list.length, 'mod')} from disk?`,
      description: `Every Workshop folder listed below is removed${extra}. There is no undo.`,
      items: list.map((mod) => mod.name || mod.workshop_id),
      confirmLabel: 'Delete all',
      destructive: true,
    })
    if (!confirmed) return
    setBusyId(batch)
    try {
      const result = await modsApi.batchDeleteDiskMods(list.map((mod) => mod.workshop_id))
      notify('Deleted', `${result.deletedFromDisk} of ${plural(result.total, 'folder')} removed, ${plural(result.modIdsStripped, 'mod ID')} taken out of the config.`, 'success')
      await refreshAll()
    } catch (error) {
      notify("Couldn't delete", getUserErrorMessage(error, 'Try again.'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const unignore = (workshopId: string) =>
    data.runExclusive("Couldn't stop ignoring", async () => {
      await modsApi.unignoreMod(workshopId)
      notify('No longer ignored', 'Sync can track this mod again.', 'success')
      void data.fetchData()
    })
  const clearIgnored = () =>
    data.runExclusive("Couldn't clear the list", async () => {
      const result = await modsApi.clearAllIgnoredMods()
      notify('Ignore list cleared', result.message, 'success')
      void data.fetchData()
    })

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tracked, but not in the server config</CardTitle>
          <CardDescription>The panel tracks these, but WorkshopItems= doesn't list them, so the server doesn't load them.</CardDescription>
          {deactivated.length > 0 && (
            <CardAction className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void reEnable(chosen)} disabled={!chosen.length || loading}>
                <PlusCircle />
                Re-enable{chosen.length ? ` (${chosen.length})` : ''}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void untrack()} disabled={loading}>
                Stop tracking {chosen.length ? `(${chosen.length})` : 'all'}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardPanel className="px-0 pb-0">
          {!iniConfig ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">Loading the server config…</p>
          ) : deactivated.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">None. Every tracked mod is in WorkshopItems=.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-y bg-muted/40 px-3 py-2 text-sm">
                <Checkbox
                  checked={chosen.length === deactivatedIds.length}
                  indeterminate={chosen.length > 0 && chosen.length < deactivatedIds.length}
                  onCheckedChange={(checked) => setSelected(checked ? new Set(deactivatedIds) : new Set())}
                  aria-label="Select all"
                />
                <span className="text-muted-foreground">{chosen.length ? `${chosen.length} selected` : `Select all (${deactivatedIds.length})`}</span>
                {genericNames.length > 0 && (
                  <Button size="xs" variant="outline" className="ms-auto" onClick={() => void refreshNames()} disabled={loading}>
                    <RefreshCw />
                    Look up {plural(genericNames.length, 'missing name')}
                  </Button>
                )}
              </div>
              {deactivated.map((mod) => {
                const label = mod.name || `Workshop Mod ${mod.workshop_id}`
                return (
                  <ModRow
                    key={mod.id}
                    selected={selected.has(mod.workshop_id)}
                    leading={
                      <div className="flex items-center gap-3">
                        <Checkbox
                          checked={selected.has(mod.workshop_id)}
                          onCheckedChange={() =>
                            setSelected((prev) => {
                              const next = new Set(prev)
                              if (next.has(mod.workshop_id)) next.delete(mod.workshop_id)
                              else next.add(mod.workshop_id)
                              return next
                            })
                          }
                          aria-label={`Select ${label}`}
                        />
                        <WorkshopThumb wsId={mod.workshop_id} label={label} demo={demo} size="sm" fallback={<Package className="size-4" />} />
                      </div>
                    }
                    title={<span className="truncate font-medium">{label}</span>}
                    meta={
                      <>
                        <WorkshopIdChip wsId={mod.workshop_id} />
                        {mod.last_checked && <span>Checked {new Date(mod.last_checked).toLocaleDateString('en')}</span>}
                      </>
                    }
                    actions={
                      <>
                        <WorkshopLink wsId={mod.workshop_id} label={label} />
                        <Button size="icon-sm" variant="ghost" onClick={() => void reEnable([mod.workshop_id])} disabled={loading} aria-label={`Re-enable ${label}`}>
                          <PlusCircle />
                        </Button>
                      </>
                    }
                  />
                )
              })}
            </>
          )}
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Downloaded, but not enabled</CardTitle>
          <CardDescription>In the Workshop folder on disk, but not in the server config.</CardDescription>
          <CardAction className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => void loadDisk()} disabled={diskLoading}>
              {diskLoading ? <Spinner /> : <RefreshCw />}
              Rescan
            </Button>
            {disk && disk.length > 0 && (
              <Button size="sm" variant="ghost" className="text-destructive-foreground" onClick={() => void deleteMany(disk, BATCH_DISK, '')} disabled={busyId !== null || loading}>
                {busyId === BATCH_DISK ? <Spinner /> : <Trash2 />}
                Delete all
              </Button>
            )}
          </CardAction>
        </CardHeader>
        <CardPanel className="px-0 pb-0">
          {disk === null || diskLoading ? (
            <p className="flex items-center gap-2 px-6 pb-6 text-sm text-muted-foreground">
              <Spinner />
              Scanning the Workshop folder…
            </p>
          ) : disk.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">None. Everything in the Workshop folder is enabled.</p>
          ) : (
            <div className="border-t">
              {disk.map((mod) => (
                <ModRow
                  key={mod.workshop_id}
                  title={<span className="truncate">{mod.name}</span>}
                  meta={<WorkshopIdChip wsId={mod.workshop_id} />}
                  actions={
                    <>
                      <WorkshopLink wsId={mod.workshop_id} label={mod.name} />
                      <Button size="sm" variant="outline" onClick={() => void enableDiskMod(mod.workshop_id)} disabled={busyId !== null || loading}>
                        {busyId === mod.workshop_id ? <Spinner /> : <PlusCircle />}
                        Enable
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => void deleteFromDisk(mod.workshop_id, mod.name)} disabled={busyId !== null || loading} aria-label={`Delete ${mod.name} from disk`}>
                        <Trash2 />
                      </Button>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </CardPanel>
      </Card>

      {ignoredMods.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ignored by sync</CardTitle>
            <CardDescription>Reading the server config skips these, so they aren't tracked again.</CardDescription>
            <CardAction className="flex gap-2">
              <Button size="sm" variant="ghost" className="text-destructive-foreground" onClick={() => void deleteMany(ignoredMods, BATCH_IGNORED, ' and the ignore list is cleared')} disabled={busyId !== null || loading}>
                {busyId === BATCH_IGNORED ? <Spinner /> : <Trash2 />}
                Delete all from disk
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void clearIgnored()} disabled={busyId !== null || loading}>
                Clear the list
              </Button>
            </CardAction>
          </CardHeader>
          <CardPanel className="px-0 pb-0">
            <div className="border-t">
              {ignoredMods.map((mod) => (
                <ModRow
                  key={mod.workshop_id}
                  title={<span className="truncate text-muted-foreground">{mod.name || `Workshop Mod ${mod.workshop_id}`}</span>}
                  meta={<WorkshopIdChip wsId={mod.workshop_id} />}
                  actions={
                    <>
                      <Button size="sm" variant="ghost" onClick={() => void unignore(mod.workshop_id)} disabled={busyId !== null || loading}>
                        Track again
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => void deleteFromDisk(mod.workshop_id, mod.name)} disabled={busyId !== null || loading} aria-label="Delete from disk">
                        {busyId === mod.workshop_id ? <Spinner /> : <Trash2 />}
                      </Button>
                    </>
                  }
                />
              ))}
            </div>
          </CardPanel>
        </Card>
      )}
    </div>
  )
}
