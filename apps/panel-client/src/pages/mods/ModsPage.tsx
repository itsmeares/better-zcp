import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronDown, FolderOpen, Plus, RefreshCw, Settings2, X } from 'lucide-react'
import { modsApi, serversApi } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { EmptyState } from '@/components/EmptyState'
import { FolderBrowser } from '@/components/FolderBrowser'
import { ConflictsPanel } from '@/components/mods/ConflictsPanel'
import { WorkshopSettingsDialog } from '@/components/mods/WorkshopSettingsDialog'
import { PageHeader } from '@/components/PageHeader'
import { WorkshopCollectionPanel } from '@/components/WorkshopCollectionPanel'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Group, GroupSeparator } from '@/components/ui/group'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import type { ModsView } from '@/routes/mods'
import { AddModsDialog, type AddTab } from './AddModsDialog'
import { LoadOrderView } from './LoadOrderView'
import { ModIdsView } from './ModIdsView'
import { notify, plural } from './modsShared'
import { NotLoadedView } from './NotLoadedView'
import { ToolsView } from './ToolsView'
import { useConflictScan } from './useConflictScan'
import { useDepSearch } from './useDepSearch'
import { useModsData } from './useModsData'
import { syncFromServer, useRemoveMods, WorkshopItemsView } from './WorkshopItemsView'

const VIEWS: Array<{ id: ModsView; label: string; hint: string }> = [
  { id: 'items', label: 'Workshop items', hint: 'What the server loads, and which have updates' },
  { id: 'ids', label: 'Mod IDs', hint: 'The internal IDs each item turns on' },
  { id: 'order', label: 'Load order', hint: 'Later mods win when two change the same file' },
  { id: 'conflicts', label: 'Conflicts', hint: 'Clashing files and missing requirements' },
  { id: 'not-loaded', label: 'Not loaded', hint: 'Tracked, downloaded or ignored, but off' },
  { id: 'collection', label: 'Collection sync', hint: 'Keep the server in step with a Steam collection' },
  { id: 'tools', label: 'Tools', hint: 'Repairs and raw config lines' },
]

const STEAM_ISSUE_KEY = 'pz-mods-steam-api-issue-dismissed'
const CONFIG_VIEWS: ModsView[] = ['ids', 'order', 'tools']

function lastChecked(iso: string | null | undefined) {
  if (!iso) return 'Never checked'
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 60) return `Checked ${seconds}s ago`
  if (seconds < 3600) return `Checked ${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `Checked ${Math.floor(seconds / 3600)}h ago`
  return `Checked ${new Date(iso).toLocaleDateString('en')}`
}

export default function ModsPage() {
  const { view = 'items' } = useSearch({ from: '/mods' })
  const navigate = useNavigate({ from: '/mods' })
  const data = useModsData()
  const scan = useConflictScan(data)
  const depSearch = useDepSearch(data)
  const removeMods = useRemoveMods(data)
  const { status, iniConfig, mods, loading } = data
  const [addOpen, setAddOpen] = useState(false)
  const [addTab, setAddTab] = useState<AddTab>('item')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const [folderStart, setFolderStart] = useState<string>()
  const [savingFolder, setSavingFolder] = useState(false)
  const [steamDismissed, setSteamDismissed] = useState(() => {
    try {
      return localStorage.getItem(STEAM_ISSUE_KEY)
    } catch {
      return null
    }
  })
  const scannedOnce = useRef(false)

  const setView = (next: ModsView) => void navigate({ search: { view: next === 'items' ? undefined : next }, replace: true })

  // Conflicts scans on first open when there's no saved result.
  useEffect(() => {
    if (view !== 'conflicts' || !scan.cacheChecked || scannedOnce.current || scan.conflicts || scan.loading) return
    scannedOnce.current = true
    void scan.scan()
  }, [view, scan])

  const openAdd = (tab: AddTab) => {
    setAddTab(tab)
    setAddOpen(true)
  }

  const checkUpdates = async () => {
    if (data.busyRef.current) return
    data.busyRef.current = true
    setChecking(true)
    try {
      const result = await modsApi.checkUpdates()
      const count = (Array.isArray(result?.mods) ? result.mods.length : 0) || (typeof result?.updatesFound === 'number' ? result.updatesFound : 0)
      if (result?.error) notify("Couldn't check for updates", String(result.error), 'error')
      else if (result?.skipped) notify('Already checking', 'A check is running.')
      else notify('Checked for updates', count === 0 ? 'Every mod is up to date.' : `${plural(count, 'mod has', 'mods have')} an update.`, count ? 'warning' : 'success')
      void data.fetchData()
    } catch (error) {
      notify("Couldn't check for updates", getUserErrorMessage(error, 'Try again.'), 'error')
    } finally {
      setChecking(false)
      data.busyRef.current = false
    }
  }

  const openFolderPicker = async () => {
    try {
      const { server } = await serversApi.getActive()
      if (!server) {
        notify('No server selected', 'Select a server with files on this machine first.', 'error')
        return
      }
      const installPath = server.installPath?.trim() || ''
      const lastSlash = Math.max(installPath.lastIndexOf('\\'), installPath.lastIndexOf('/'))
      // A start script path starts the picker in its folder.
      setFolderStart(/\.(bat|cmd|exe|sh)$/i.test(installPath) && lastSlash >= 0 ? installPath.slice(0, lastSlash) : installPath || undefined)
      setFolderOpen(true)
    } catch (error) {
      reportClientWarning('Could not load the active server path before opening the folder browser.', error)
      notify("Couldn't open the folder picker", getUserErrorMessage(error, "The selected server didn't load."), 'error')
    }
  }

  const saveFolder = async (path: string) => {
    if (savingFolder || !path.trim()) return
    setSavingFolder(true)
    try {
      const { server } = await serversApi.getActive()
      await serversApi.update(server.id, { installPath: path.trim() })
      await data.fetchData()
      notify('Workshop folder found', 'Update checks can run now.', 'success')
    } catch (error) {
      notify("Couldn't save the folder", getUserErrorMessage(error, 'Pick the folder that holds the server files.'), 'error')
    } finally {
      setSavingFolder(false)
    }
  }

  const cancelRestart = () =>
    data.runExclusive("Couldn't cancel", async () => {
      await modsApi.cancelPendingRestart()
      notify('Restart cancelled', undefined, 'success')
      void data.fetchData()
    })

  const updates = mods.filter((mod) => mod.update_available).length
  const removed = (status?.removedWorkshopIds ?? []).map((id) => ({ id, name: mods.find((mod) => mod.workshop_id === id)?.name ?? null }))
  const notLoaded = iniConfig ? mods.filter((mod) => !iniConfig.workshopIds.includes(mod.workshop_id)).length : 0
  const current = VIEWS.find((entry) => entry.id === view)!

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Mods"
        description="Workshop mods on the selected server: updates, IDs, load order and conflicts."
        actions={
          <>
            <Button variant="outline" onClick={() => void checkUpdates()} disabled={checking}>
              {checking ? <Spinner /> : <RefreshCw />}
              Check for updates
            </Button>
            <Group>
              <Button onClick={() => openAdd('item')}>
                <Plus />
                Add mods
              </Button>
              <GroupSeparator />
              <Menu>
                <MenuTrigger render={<Button size="icon" aria-label="More ways to add and settings" />}>
                  <ChevronDown />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => openAdd('collection')}>Import a collection…</MenuItem>
                  <MenuItem onClick={() => void syncFromServer(data)} disabled={loading}>
                    Track what the server config lists
                  </MenuItem>
                  <MenuItem onClick={() => setSettingsOpen(true)}>
                    <Settings2 />
                    Workshop settings
                  </MenuItem>
                  <MenuItem render={<Link to="/schedule" />}>
                    <Settings2 />
                    Restart on update settings
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </Group>
          </>
        }
      />

      {data.fetchError && (
        <Alert variant="error">
          <AlertTitle>Mod data didn't load</AlertTitle>
          <AlertDescription>{data.fetchError}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void data.fetchData()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {(status?.totalModsTracked ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{plural(status?.totalModsTracked ?? 0, 'mod')} tracked</span>
          <span aria-hidden>·</span>
          <span title={`${iniConfig?.totalMods ?? 0} mod IDs in Mods=. Some items have several.`}>{plural(iniConfig?.workshopIds.length ?? 0, 'Workshop item')} in the config</span>
          {updates > 0 && <Badge variant="warning">{plural(updates, 'update')}</Badge>}
          <span aria-hidden>·</span>
          <span>{lastChecked(status?.lastCheck)}</span>
        </div>
      )}

      {status && !status.workshopAcfConfigured && (status.totalModsTracked ?? 0) > 0 && (
        <Alert variant="error">
          <AlertTitle>The panel can't find the Workshop folder</AlertTitle>
          <AlertDescription>Update checks need it. Point the panel at the folder that holds the server files.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void openFolderPicker()} disabled={savingFolder}>
              <FolderOpen />
              Find it
            </Button>
          </AlertAction>
        </Alert>
      )}
      {status?.pendingRestart && (
        <Alert variant="warning">
          <AlertTitle>A restart for mod updates is waiting</AlertTitle>
          <AlertDescription>
            {status.forceAfterDeadline
              ? 'Waiting for players to leave. The warning countdown starts before the deadline.'
              : `Waiting up to ${status.maxDelayMinutes} minutes for an empty server, then putting the restart off.`}
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void cancelRestart()} disabled={loading}>
              Cancel the restart
            </Button>
          </AlertAction>
        </Alert>
      )}
      {!status?.pendingRestart && (status?.updatesAvailable ?? 0) > 0 && updates === 0 && !checking && (
        <Alert variant="warning">
          <AlertTitle>Steam reports {plural(status?.updatesAvailable ?? 0, 'update')} the list doesn't show</AlertTitle>
          <AlertDescription>The Workshop folder has newer files than the panel's records. A check brings the list up to date.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void checkUpdates()}>
              Check now
            </Button>
          </AlertAction>
        </Alert>
      )}
      {removed.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>{plural(removed.length, 'mod is', 'mods are')} gone from the Steam Workshop</AlertTitle>
          <AlertDescription>
            Steam says these were deleted or made private. They keep failing update checks and can break the next restart until removed.
            <span className="mt-2 flex flex-wrap gap-1.5">
              {removed.map((mod) => (
                <Badge key={mod.id} variant="outline" className="gap-1">
                  {mod.name || mod.id}
                  <button type="button" onClick={() => void removeMods([mod.id])} aria-label={`Remove ${mod.name || mod.id}`} className="hover:text-destructive-foreground">
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </span>
          </AlertDescription>
        </Alert>
      )}
      {status && !status.steamApiHealthy && status.lastSteamApiFailureAt && steamDismissed !== status.lastSteamApiFailureAt && (
        <Alert variant="info">
          <AlertDescription>The Steam Workshop didn't answer on the last check, so the panel used local files. It tries again on its own.</AlertDescription>
          <AlertAction>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss until the next failed check"
              onClick={() => {
                const since = status.lastSteamApiFailureAt!
                try {
                  localStorage.setItem(STEAM_ISSUE_KEY, since)
                } catch {
                  /* storage disabled */
                }
                setSteamDismissed(since)
              }}
            >
              <X />
            </Button>
          </AlertAction>
        </Alert>
      )}
      {(status?.unknownWorkshopIds?.length ?? 0) > 0 && (
        <p className="text-sm text-muted-foreground">
          Steam gave an unexpected answer for {plural(status!.unknownWorkshopIds.length, 'item')}: {status!.unknownWorkshopIds.map((item) => `${item.id} (code ${item.resultCode})`).join(', ')}
        </p>
      )}
      {(iniConfig?.duplicateKeys?.length ?? 0) > 0 && (
        <Alert variant="warning">
          <AlertTitle>{iniConfig!.duplicateKeys!.map((entry) => entry.key).join(', ')} {iniConfig!.duplicateKeys!.length === 1 ? 'is' : 'are'} in the config file more than once</AlertTitle>
          <AlertDescription>Mods reads the first copy and Configuration reads the last, so they can show different values. Remove the extra line in Configuration.</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3">
        <Tabs value={view} onValueChange={(value) => setView(value as ModsView)}>
          <TabsList className="flex-wrap">
            {VIEWS.map((entry) => (
              <TabsTab key={entry.id} value={entry.id} title={entry.hint}>
                {entry.label}
                {entry.id === 'not-loaded' && notLoaded > 0 && <span className="text-muted-foreground tabular-nums">{notLoaded}</span>}
                {entry.id === 'order' && data.hasModOrderChanged && <span className="size-1.5 rounded-full bg-warning" aria-label="Unsaved order" />}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
        <p className="text-sm text-muted-foreground">{current.hint}.</p>

        {CONFIG_VIEWS.includes(view) && iniConfig && !iniConfig.configured ? (
          <EmptyState type="noFile" title="No server config yet" description={iniConfig.error || 'Start the server once and it creates the file.'} />
        ) : (
          <>
            {view === 'items' && <WorkshopItemsView data={data} onAdd={() => openAdd('item')} onImport={() => openAdd('collection')} />}
            {view === 'ids' && <ModIdsView data={data} scan={scan} depSearch={depSearch} />}
            {view === 'order' && <LoadOrderView data={data} scan={scan} />}
            {view === 'conflicts' && (
              <ConflictsPanel
                conflicts={scan.conflicts}
                conflictsLoading={scan.loading}
                conflictsError={scan.error}
                conflictsStale={scan.stale}
                lastScanTime={scan.lastScanTime}
                scanConflicts={() => void scan.scan()}
                scanProgress={scan.progress}
                scanCurrentMod={scan.currentMod}
                scanModsScanned={scan.modsScanned}
                scanTotalMods={scan.totalMods}
                streamConflicts={scan.streamConflicts}
                fetchData={data.fetchData}
                busyRef={data.busyRef}
                savingModOrder={scan.savingOrder}
                promoteModOverOpponent={scan.promoteModOverOpponent}
                depSearchOpen={depSearch.open}
                setDepSearchOpen={depSearch.setOpen}
                depSearchData={depSearch.results}
                setDepSearchData={depSearch.setResults}
                depAdding={depSearch.adding}
                setDepAdding={depSearch.setAdding}
                depAddResults={depSearch.outcomes}
                setDepAddResults={depSearch.setOutcomes}
              />
            )}
            {view === 'not-loaded' && <NotLoadedView data={data} />}
            {view === 'collection' && <WorkshopCollectionPanel onOpenSettings={() => setSettingsOpen(true)} />}
            {view === 'tools' && <ToolsView data={data} />}
          </>
        )}
      </div>

      <AddModsDialog data={data} open={addOpen} tab={addTab} onOpenChange={setAddOpen} onTabChange={setAddTab} />
      <WorkshopSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <FolderBrowser open={folderOpen} onOpenChange={setFolderOpen} onSelect={(path) => void saveFolder(path)} initialPath={folderStart} title="Pick the Project Zomboid server folder" />
    </div>
  )
}
