import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { CircleAlert, Download, ExternalLink, FileText, History, Map, MapPin, MoreHorizontal, Puzzle, RefreshCw, Settings } from 'lucide-react'
import { saveBlob, serverFilesApi, type SandboxData } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { parseNumericSettingValue, SANDBOX_SCHEMA } from '@/lib/serverConfigSchema'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useSocket } from '@/contexts/SocketContext'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { PageLoading } from '@/components/PageLoading'
import { SaveBar } from '@/components/settings-layout'
import { useShell } from '@/components/shell/useShellStatus'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { toastManager } from '@/components/ui/toast'
import type { ConfigTab } from '@/routes/config'
import {
  changedIniFields,
  changedSandboxFields,
  getUnpersistedSandboxKeys,
  previewValue,
  rawChangePreview,
  sandboxChangePreview,
  type ConfigFile,
} from './configFiles'
import { ConfigHistoryDialog } from './ConfigHistoryDialog'
import { IniEditor, invalidIniKeys } from './IniEditor'
import { ModOptions } from './ModOptions'
import { RawEditor } from './RawEditor'
import { invalidSandboxSettings, SandboxEditor } from './SandboxEditor'
import { readStoredFilter, storeFilter, type FilterMode } from './SettingsBrowser'
import { SpawnRegionsEditor } from './SpawnRegionsEditor'
import { useConfigFiles } from './useConfigFiles'

const TAB_META: Record<ConfigTab, { label: string; icon: typeof Settings }> = {
  ini: { label: 'Server settings', icon: Settings },
  sandbox: { label: 'Sandbox', icon: FileText },
  spawnpoints: { label: 'Spawn points', icon: MapPin },
  spawnregions: { label: 'Spawn regions', icon: Map },
  modsettings: { label: 'Mod options', icon: Puzzle },
}

const FILE_LABEL: Record<ConfigFile, string> = { ini: 'server settings', sandbox: 'sandbox', spawnpoints: 'spawn points', spawnregions: 'spawn regions' }
const WIKI: Partial<Record<ConfigFile, string>> = { ini: 'https://pzwiki.net/wiki/Server_settings', sandbox: 'https://pzwiki.net/wiki/Sandbox_options' }
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export default function ConfigPage() {
  const routeSearch = useSearch({ from: '/config' })
  const navigate = useNavigate({ from: '/config' })
  const { runState } = useShell()
  const files = useConfigFiles()
  const confirm = useConfirm()
  const socket = useSocket()
  const tab: ConfigTab = routeSearch.tab ?? 'ini'
  const [search, setSearch] = useState(routeSearch.search ?? '')
  const [filter, setFilter] = useState<FilterMode>(() => (routeSearch.search ? 'all' : readStoredFilter()))
  const [saving, setSaving] = useState(false)
  const [locked, setLocked] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const iniSearchRef = useRef<HTMLInputElement>(null)
  const sandboxSearchRef = useRef<HTMLInputElement>(null)
  const { paths, raw } = files
  const file: ConfigFile | null = tab === 'modsettings' ? null : tab
  const dirty = file ? files.isDirty(file) : false

  const setTab = (next: ConfigTab) => void navigate({ search: (prev) => ({ ...prev, tab: next === 'ini' ? undefined : next }), replace: true })
  const changeFilter = (mode: FilterMode) => {
    setFilter(mode)
    storeFilter(mode)
  }

  // Switching servers under unsaved edits would save them to the wrong server, so the page locks until reloaded.
  const anyDirty = files.anyDirty
  const { load } = files
  useEffect(() => {
    if (!socket) return
    const onServersChanged = () => {
      if (anyDirty) setLocked(true)
      else void load()
    }
    socket.on('servers:changed', onServersChanged)
    return () => {
      socket.off('servers:changed', onServersChanged)
    }
  }, [socket, anyDirty, load])

  useEffect(() => {
    if (!anyDirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])

  const reload = async () => {
    await files.load()
    setLocked(false)
  }

  const save = async (target: ConfigFile) => {
    if (locked) {
      toastManager.add({ title: 'The selected server changed', description: 'Reload before saving, so the save goes to the right server.', type: 'error' })
      return
    }
    const text = raw[target]
    const serverId = paths?.serverId ?? null
    const name = paths?.serverName || 'server'
    const filename = { ini: `${name}.ini`, sandbox: `${name}_SandboxVars.lua`, spawnpoints: `${name}_spawnpoints.lua`, spawnregions: `${name}_spawnregions.lua` }[target]

    let preview: string[]
    let iniChanges: Record<string, string> = {}
    if (text) {
      preview = rawChangePreview(text.saved, text.value)
    } else if (target === 'ini') {
      const invalid = invalidIniKeys(files.ini.value)
      if (invalid.length) {
        toastManager.add({ title: 'Fix these numbers first', description: invalid.map((setting) => setting.label).join(', '), type: 'error' })
        return
      }
      iniChanges = changedIniFields(files.ini.value, files.ini.saved)
      preview = Object.entries(iniChanges).map(([key, value]) => `${key}: ${previewValue(key, files.ini.saved[key])} → ${previewValue(key, value)}`)
    } else if (target === 'sandbox') {
      const invalid = invalidSandboxSettings(files.sandbox.value)
      if (invalid.length) {
        toastManager.add({ title: 'Fix these numbers first', description: invalid.map((setting) => setting.label).join(', '), type: 'error' })
        return
      }
      preview = files.sandbox.value && files.sandbox.saved ? sandboxChangePreview(changedSandboxFields(files.sandbox.value, files.sandbox.saved), files.sandbox.saved) : []
      if (!paths?.exists.sandbox) preview.unshift('Create SandboxVars.lua from these settings')
    } else if (target === 'spawnpoints') {
      const before = files.spawnPoints.saved
      const after = files.spawnPoints.value
      preview = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((profession) => JSON.stringify(after[profession]) !== JSON.stringify(before[profession]))
        .map((profession) => `${profession}: ${before[profession]?.length || 0} → ${after[profession]?.length || 0} spawn points`)
    } else {
      const before = files.regions.saved
      preview = files.regions.value
        .filter((region, index) => JSON.stringify(region) !== JSON.stringify(before[index]))
        .map((region) => `${region.name || '(no name)'}: ${region.file}`)
      if (files.regions.value.length < before.length) preview.push(`${plural(before.length - files.regions.value.length, 'region')} removed`)
      if (!paths?.exists.spawnregions) preview.unshift('Create the spawn regions file')
    }

    if (preview.length === 0) {
      toastManager.add({ title: 'Nothing to save' })
      return
    }
    const confirmed = await confirm({
      title: `Save ${filename}?`,
      description: `${plural(preview.length, 'change')} for ${name}. The panel keeps a copy of the current file first. Some changes need a server restart.`,
      items: preview.length > 12 ? [...preview.slice(0, 12), `${preview.length - 12} more`] : preview,
      confirmLabel: 'Save',
    })
    if (!confirmed) return

    setSaving(true)
    try {
      let restartRequired = false
      if (text) {
        await serverFilesApi.saveRaw(target, text.value, serverId)
      } else if (target === 'ini') {
        await serverFilesApi.saveIni(iniChanges, serverId)
      } else if (target === 'sandbox' && files.sandbox.value) {
        // Number fields hold typed text while editing; the file stores numbers.
        const clean = structuredClone(files.sandbox.value) as SandboxData
        for (const setting of SANDBOX_SCHEMA) {
          if (setting.type !== 'number') continue
          const section = clean[(setting.section || 'settings') as keyof SandboxData] as Record<string, unknown> | undefined
          const value = section?.[setting.key]
          if (section && value !== undefined && value !== null && String(value).trim() !== '') section[setting.key] = parseNumericSettingValue(value, setting)
        }
        const submitted = paths?.exists.sandbox && files.sandbox.saved ? changedSandboxFields(clean, files.sandbox.saved) : clean
        const result = await serverFilesApi.saveSandbox(submitted, serverId)
        const lost = getUnpersistedSandboxKeys(result)
        if (lost) {
          toastManager.add({ title: 'Some settings weren’t saved', description: `The rest saved, but these reset when the server restarts: ${lost.join(', ')}`, type: 'error' })
        }
        restartRequired = true
      } else if (target === 'spawnpoints') {
        restartRequired = Boolean(((await serverFilesApi.saveSpawnPoints(files.spawnPoints.value, serverId)) as { restartRequired?: boolean })?.restartRequired)
      } else if (target === 'spawnregions') {
        restartRequired = Boolean(((await serverFilesApi.saveSpawnRegions(files.regions.value, serverId)) as { restartRequired?: boolean })?.restartRequired)
      }

      if (target === 'ini') {
        try {
          await serverFilesApi.saveAndReload(serverId)
          toastManager.add({ title: 'Saved and reloaded', description: 'The server picked up the new settings.', type: 'success' })
        } catch {
          toastManager.add({ title: 'Saved', description: 'Restart the server to apply the changes.', type: 'success' })
        }
      } else {
        toastManager.add({ title: 'Saved', description: restartRequired ? 'Restart the server to apply the changes.' : undefined, type: 'success' })
      }
      await files.reloadFile(target)
    } catch (error) {
      toastManager.add({ title: 'Save failed', description: getUserErrorMessage(error, 'The file was not changed.'), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key === 's') {
        event.preventDefault()
        if (file && dirty) void saveRef.current(file)
      } else if (event.key === 'f' && (tab === 'ini' || tab === 'sandbox') && !raw[tab]) {
        event.preventDefault()
        ;(tab === 'ini' ? iniSearchRef : sandboxSearchRef).current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [file, dirty, tab, raw])

  const download = async (target: ConfigFile) => {
    try {
      const data = await serverFilesApi.getRaw(target)
      saveBlob(new Blob([data.content], { type: 'text/plain' }), `${data.filename}_${new Date().toISOString().replace(/[:.]/g, '-')}.bak`)
    } catch (error) {
      toastManager.add({ title: 'Download failed', description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    }
  }

  const setMode = async (target: ConfigFile, asText: boolean) => {
    if (asText === Boolean(raw[target])) return
    if (files.isDirty(target)) {
      const confirmed = await confirm({
        title: 'Drop your unsaved edits?',
        description: `Switching between the form and the text loses unsaved edits to ${FILE_LABEL[target]}.`,
        confirmLabel: 'Drop edits',
        destructive: true,
      })
      if (!confirmed) return
      files.discard(target)
    }
    if (asText) await files.loadRaw(target, paths?.exists[target] ?? false)
    else files.closeRaw(target)
  }

  if (files.loading && !paths) return <PageLoading />

  const toolbar = (target: ConfigFile, description: string, hasForm = true) => (
    <div className="flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {description}
        {paths && !paths.exists[target] && <span className="text-warning-foreground"> This server has no {FILE_LABEL[target]} file yet. Saving creates it.</span>}
      </p>
      {hasForm && (
        <Tabs value={raw[target] ? 'raw' : 'form'} onValueChange={(value) => void setMode(target, value === 'raw')}>
          <TabsList aria-label="Edit as">
            <TabsTab value="form">Form</TabsTab>
            <TabsTab value="raw">Text</TabsTab>
          </TabsList>
        </Tabs>
      )}
      <Menu>
        <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`More for ${FILE_LABEL[target]}`} />}>
          <MoreHorizontal />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => void download(target)} disabled={!paths?.exists[target]}>
            <Download />
            Download a copy
          </MenuItem>
          {WIKI[target] && (
            <MenuItem render={<a href={WIKI[target]} target="_blank" rel="noopener noreferrer" />}>
              <ExternalLink />
              What each setting does
            </MenuItem>
          )}
          {target === 'spawnpoints' && (
            <MenuItem render={<Link to="/map" />}>
              <Map />
              Find coordinates on the map
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  )

  const textEditor = (target: ConfigFile) => {
    const text = raw[target]
    return text ? <RawEditor value={text.value} onChange={(value) => files.setRawText(target, value)} label={`${FILE_LABEL[target]} file`} /> : null
  }

  return (
    <div className="grid gap-6 pb-20">
      <PageHeader
        title="Configuration"
        description={
          paths ? (
            <>
              {paths.serverName}
              <span className="ms-2 font-mono text-xs" title={paths.configPath}>
                {paths.configPath}
              </span>
            </>
          ) : (
            'The server’s settings files.'
          )
        }
        actions={
          <>
            <Button variant="ghost" size="icon" onClick={() => void reload()} aria-label="Reload the files" disabled={files.loading}>
              <RefreshCw />
            </Button>
            <Button variant="outline" onClick={() => setHistoryOpen(true)}>
              <History />
              File history
            </Button>
          </>
        }
      />

      {files.loadError && (
        <Alert variant="error">
          <AlertTitle>The config files didn't load</AlertTitle>
          <AlertDescription>{files.loadError}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {locked && (
        <Alert variant="error">
          <AlertTitle>The selected server changed</AlertTitle>
          <AlertDescription>These are still the previous server's settings. Reload before saving, or the save would overwrite the new server's files.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void reload()}>
              Reload
            </Button>
          </AlertAction>
        </Alert>
      )}
      {files.duplicateKeys.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>
            {files.duplicateKeys.length === 1 ? `${files.duplicateKeys[0].key} is in the file twice` : `${files.duplicateKeys.length} settings are in the file more than once`}
          </AlertTitle>
          <AlertDescription>
            {files.duplicateKeys.length > 1 && `${files.duplicateKeys.map((entry) => entry.key).join(', ')}. `}
            This editor reads the last copy and Mods reads the first, so they can show different values. Remove the extra line in Text mode.
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as ConfigTab)} className="gap-4">
        <TabsList className="flex-wrap">
          {(Object.keys(TAB_META) as ConfigTab[]).map((key) => {
            const { label, icon: Icon } = TAB_META[key]
            const tabFile = key === 'modsettings' ? null : key
            return (
              <TabsTab key={key} value={key}>
                <Icon />
                {label}
                {tabFile && files.isDirty(tabFile) && <span className="size-1.5 rounded-full bg-warning" aria-label="Unsaved changes" />}
                {tabFile && paths && !paths.exists[tabFile] && <CircleAlert className="text-warning-foreground" aria-label="File missing" />}
              </TabsTab>
            )
          })}
        </TabsList>

        {runState !== 'stopped' && file && (
          <p className="text-sm text-muted-foreground">
            {runState === 'running' ? 'The server is running.' : "The panel can't confirm the server is stopped."} You can save now. Some changes need a restart, and the message after saving says so.
          </p>
        )}

        <TabsPanel value="ini" className="grid gap-3">
          {toolbar('ini', 'How the server runs: name, ports, players, safety, mods and backups.')}
          {textEditor('ini') ?? (
            <IniEditor files={files} search={search} onSearch={setSearch} filter={filter} onFilter={changeFilter} searchRef={iniSearchRef} />
          )}
        </TabsPanel>
        <TabsPanel value="sandbox" className="grid gap-3">
          {toolbar('sandbox', 'The world rules: time, zombies, loot and survival. Values and wording follow Build 42.')}
          {textEditor('sandbox') ?? (
            <SandboxEditor files={files} search={search} onSearch={setSearch} filter={filter} onFilter={changeFilter} searchRef={sandboxSearchRef} />
          )}
        </TabsPanel>
        <TabsPanel value="spawnpoints" className="grid gap-3">
          {toolbar('spawnpoints', 'Where each profession starts. Usually a mod such as Spawn Select manages this.', false)}
          {textEditor('spawnpoints') ?? (
            <EmptyState
              type="noFile"
              title="Spawn points are edited as text"
              description="There's no form for this file because mods usually manage it."
              action={{ label: 'Open the file', onClick: () => void setMode('spawnpoints', true), variant: 'outline' }}
            />
          )}
        </TabsPanel>
        <TabsPanel value="spawnregions" className="grid gap-3">
          {toolbar('spawnregions', 'The towns players pick from when they first join.')}
          {textEditor('spawnregions') ?? <SpawnRegionsEditor regions={files.regions.value} onChange={(value) => files.setRegions((prev) => ({ ...prev, value }))} />}
        </TabsPanel>
        <TabsPanel value="modsettings" className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Options that installed mods add. They change live through the game integration and save right away. <Badge variant="secondary">Live</Badge>
          </p>
          <ModOptions active={tab === 'modsettings'} locked={locked} />
        </TabsPanel>
      </Tabs>

      {file && dirty && (
        <SaveBar
          message={`Unsaved changes to ${FILE_LABEL[file]}`}
          detail="Ctrl+S saves. The panel keeps a copy first."
          saving={saving}
          saveDisabled={locked}
          onSave={() => void save(file)}
          onDiscard={() => files.discard(file)}
        />
      )}

      <ConfigHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} serverId={paths?.serverId ?? null} onRestored={() => void reload()} />
    </div>
  )
}
