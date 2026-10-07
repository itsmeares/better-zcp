import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronLeft, Loader2, Plus, Search } from 'lucide-react'
import { serversApi, serversDetectApi, type DiscoveredMount, type ServerInstance } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { panelQueryKeys } from '@/lib/queryClient'
import { selectServer } from '@/lib/serverSelection'
import { reportClientWarning } from '@/lib/client-errors'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { NumberInput } from '@/components/NumberInput'
import { PasswordInput } from '@/components/PasswordInput'
import { RconTestConnection } from '@/components/RconTestConnection'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { isCustomLauncherPath } from '@/components/server/SteamOperationDialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { toastManager } from '@/components/ui/toast'
import { PathInput } from './shared'

interface DetectedServer {
  serverName: string
  iniFile: string
  rconPort: number
  serverPort: number
  publicName: string
  hasRcon: boolean
}

interface DetectedConfig extends DetectedServer {
  dataPath: string
  serverConfigPath: string
  matchedBatFile?: string | null
}

interface AutoScanResult {
  installPaths: string[]
  customBatFiles: Array<{ fileName: string }>
  detectedConfigs: DetectedConfig[]
}

interface Candidate {
  name: string
  serverName: string
  installPath: string
  zomboidDataPath: string
  serverConfigPath: string
  rconPort: number
  serverPort: number
  hasRcon: boolean
  useNoSteam: boolean
}

const samePath = (a?: string | null, b?: string | null) => !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** Settings in a new profile that collide with servers already in the panel. */
function findClashes(servers: ServerInstance[], candidate: Candidate) {
  const clashes: Array<{ label: string; detail: string }> = []
  for (const other of servers) {
    if (other.serverName === candidate.serverName) clashes.push({ label: 'Config name', detail: `${other.name} already uses ${other.serverName}.ini` })
    if (Math.abs(Number(other.serverPort) - candidate.serverPort) <= 1) clashes.push({ label: 'Game port', detail: `${other.name} uses ${other.serverPort} and ${Number(other.serverPort) + 1}` })
    if (Number(other.rconPort) === candidate.rconPort) clashes.push({ label: 'RCON port', detail: `${other.name} uses ${other.rconPort}` })
    if (samePath(other.zomboidDataPath, candidate.zomboidDataPath)) clashes.push({ label: 'Data folder', detail: `${other.name} uses the same Zomboid data folder` })
    if (samePath(other.installPath, candidate.installPath)) clashes.push({ label: 'Install folder', detail: `shared with ${other.name}, so a SteamCMD update or Workshop download hits both` })
  }
  return clashes
}

function DiscoveredInstall({ mount, onAdded }: { mount: DiscoveredMount; onAdded: () => void }) {
  const [serverName, setServerName] = useState(mount.serverNames[0] || '')
  const [displayName, setDisplayName] = useState(mount.serverNames[0] || '')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    setBusy(true)
    try {
      const { server } = await serversApi.createFromDiscovery({ installPath: mount.installPath, dataPath: mount.dataPath || '', serverName, name: displayName || undefined })
      await selectServer(server.id)
      toastManager.add({ title: `${server.name} added`, type: 'success' })
      onAdded()
    } catch (error) {
      toastManager.add({ title: "Couldn't add the server", description: getUserErrorMessage(error, 'Failed to create the server.'), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const items = mount.serverNames.map((name) => ({ value: name, label: `${name}.ini` }))
  return (
    <div className="grid gap-3 border-b py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <div className="grid min-w-0 gap-2">
        <code className="truncate font-mono text-sm" title={mount.installPath}>
          {mount.installPath}
        </code>
        <div className="flex flex-wrap gap-2">
          {mount.serverNames.length > 1 && (
            <Select items={items} value={serverName} onValueChange={(value) => { setServerName(String(value)); setDisplayName(String(value)) }}>
              <SelectTrigger className="w-44" aria-label="Server config">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <Input className="w-56" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={100} aria-label="Display name" placeholder="Display name" />
        </div>
      </div>
      <Button onClick={() => void add()} disabled={busy || !serverName}>
        {busy ? <Loader2 className="animate-spin" /> : <Plus />}
        Add
      </Button>
    </div>
  )
}

export function ConnectFlow({ onExit }: { onExit: () => void }) {
  const navigate = useNavigate()
  const runtimeInfo = useRuntimeInfo()
  const { data: serversData } = useQuery({ queryKey: panelQueryKeys.servers, queryFn: serversApi.getAll, staleTime: 30_000 })
  const servers = serversData?.servers ?? []
  const [mounts, setMounts] = useState<DiscoveredMount[]>([])
  const [scanPath, setScanPath] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<AutoScanResult | null>(null)
  const [dataPath, setDataPath] = useState('')
  const [installPath, setInstallPath] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [detected, setDetected] = useState<{ dataPath: string; serverConfigPath: string; installPath: string; hasNoSteam: boolean; servers: DetectedServer[] } | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [rconPassword, setRconPassword] = useState('')
  const [memory, setMemory] = useState({ min: 2, max: 4 })
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    serversApi
      .discoverMounts()
      .then((data) => setMounts((data.mounts || []).filter((mount) => mount.dataPath && mount.serverNames.length > 0)))
      .catch((error) => reportClientWarning('Mount discovery failed.', error))
  }, [])

  const clashes = useMemo(() => (candidate ? findClashes(servers, candidate) : []), [servers, candidate])
  const finish = () => void navigate({ to: '/' })

  const choose = (next: Candidate) => {
    setCandidate(next)
    setRconPassword('')
    if (!next.hasRcon) toastManager.add({ title: 'RCON is not set up', description: "This server's .ini has no RCON password. Enter one below or add RCONPassword to the .ini.", type: 'warning' })
  }

  const scan = async () => {
    setScanning(true)
    setScanResult(null)
    try {
      const data = (await serversDetectApi.autoScan({ scanPath, maxDepth: 4 })) as unknown as AutoScanResult & { error?: string }
      if (!data || data.error) throw new Error(data?.error || 'Unknown error')
      setScanResult(data)
      if (data.detectedConfigs.length === 0) toastManager.add({ title: 'No servers found in that folder' })
    } catch (error) {
      toastManager.add({ title: 'Scan failed', description: getUserErrorMessage(error, 'The folder scan failed.'), type: 'error' })
    } finally {
      setScanning(false)
    }
  }

  const detect = async () => {
    setDetecting(true)
    setDetectError(null)
    setDetected(null)
    try {
      const data = (await serversDetectApi.detect({ dataPath, installPath: installPath || undefined })) as unknown as {
        error?: string
        dataPath: string
        serverConfigPath: string
        installPath: string
        hasNoSteam: boolean
        detectedServers: DetectedServer[]
      }
      if (!data || data.error) throw new Error(data?.error || 'Detection failed')
      const result = { dataPath: data.dataPath, serverConfigPath: data.serverConfigPath, installPath: installPath || data.installPath, hasNoSteam: data.hasNoSteam, servers: data.detectedServers }
      setDetected(result)
      if (data.detectedServers.length === 1) pickDetected(data.detectedServers[0], result)
    } catch (error) {
      setDetectError(getUserErrorMessage(error, 'Detection failed.'))
    } finally {
      setDetecting(false)
    }
  }

  const pickDetected = (server: DetectedServer, result = detected) => {
    if (!result) return
    choose({
      name: server.publicName || server.serverName,
      serverName: server.serverName,
      installPath: result.installPath,
      zomboidDataPath: result.dataPath,
      serverConfigPath: result.serverConfigPath,
      rconPort: server.rconPort,
      serverPort: server.serverPort,
      hasRcon: server.hasRcon,
      useNoSteam: result.hasNoSteam,
    })
  }

  const pickScanned = (config: DetectedConfig) =>
    choose({
      name: config.publicName || config.serverName,
      serverName: config.serverName,
      installPath: config.matchedBatFile || scanResult?.installPaths[0] || '',
      zomboidDataPath: config.dataPath,
      serverConfigPath: config.serverConfigPath,
      rconPort: config.rconPort,
      serverPort: config.serverPort,
      hasRcon: config.hasRcon,
      useNoSteam: false,
    })

  const add = async () => {
    if (!candidate) return
    const importFromIni = candidate.hasRcon && !rconPassword.trim()
    if (!importFromIni && !rconPassword.trim()) {
      toastManager.add({ title: 'Enter the RCON password', type: 'error' })
      return
    }
    if (!Number.isFinite(memory.min) || !Number.isFinite(memory.max)) {
      toastManager.add({ title: 'Enter a minimum and maximum memory value', type: 'error' })
      return
    }
    setAdding(true)
    try {
      const result = await serversApi.create({
        name: candidate.name,
        serverName: candidate.serverName,
        installPath: candidate.installPath,
        zomboidDataPath: candidate.zomboidDataPath,
        serverConfigPath: candidate.serverConfigPath,
        rconHost: '127.0.0.1',
        rconPort: candidate.rconPort,
        ...(importFromIni ? { importIniFrom: { dataPath: candidate.zomboidDataPath, serverName: candidate.serverName } } : { rconPassword }),
        dockerContainerName: null,
        serverPort: candidate.serverPort,
        minMemory: memory.min,
        maxMemory: memory.max,
        useNoSteam: candidate.useNoSteam,
        useDebug: false,
      } as Partial<ServerInstance> & { importIniFrom?: { dataPath: string; serverName: string } })
      if (result.server?.id) await selectServer(result.server.id)
      toastManager.add({ title: `${candidate.name} added`, type: 'success' })
      finish()
    } catch (error) {
      toastManager.add({ title: "Couldn't add the server", description: getUserErrorMessage(error, 'Failed to add the server.'), type: 'error' })
    } finally {
      setAdding(false)
    }
  }

  if (candidate) {
    const importable = candidate.hasRcon && !rconPassword
    return (
      <div className="grid gap-4">
        <SettingsCard title={candidate.name} description={`${candidate.serverName}.ini`} action={<Badge variant="success">Found</Badge>}>
          <SettingsRow label="Data folder">
            <code className="font-mono text-sm break-all">{candidate.zomboidDataPath}</code>
          </SettingsRow>
          <SettingsRow label="Install folder" stacked description={candidate.installPath ? undefined : 'Not found. You can set it later in Server settings.'}>
            <Input className="font-mono" value={candidate.installPath} onChange={(e) => setCandidate({ ...candidate, installPath: e.target.value })} placeholder="Optional" />
          </SettingsRow>
          {isCustomLauncherPath(candidate.installPath) && (
            <div className="pb-4">
              <Alert variant="warning">
                <AlertTitle>Custom launcher</AlertTitle>
                <AlertDescription>This points at a script, so the panel runs it as-is. Memory, the admin password and the server name only apply if the script sets them.</AlertDescription>
              </Alert>
            </div>
          )}
          <SettingsRow label="Ports">
            <span className="font-mono text-sm">
              game {candidate.serverPort} · RCON {candidate.rconPort}
            </span>
          </SettingsRow>
          <SettingsRow
            label="RCON password"
            description={
              importable ? (
                <span className="text-success-foreground">Leave blank to import it from {candidate.serverName}.ini, or type one to override it.</span>
              ) : !rconPassword ? (
                `Required. You can also set RCONPassword in ${candidate.serverName}.ini.`
              ) : undefined
            }
          >
            <div className="grid justify-items-end gap-2">
              <PasswordInput className="w-56" value={rconPassword} onChange={setRconPassword} label="RCON password" placeholder={candidate.hasRcon ? 'Import from .ini' : 'Enter the password'} />
              <RconTestConnection host="127.0.0.1" port={candidate.rconPort} password={rconPassword} className="justify-items-end" />
            </div>
          </SettingsRow>
          <SettingsRow label="Memory" description="Java heap in GB.">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <NumberInput className="w-20" min={1} max={64} value={memory.min} clamp={(n) => Math.max(1, n)} onChange={(min) => setMemory((m) => ({ ...m, min }))} aria-label="Minimum memory in GB" />
              to
              <NumberInput className="w-20" min={1} max={64} value={memory.max} clamp={(n) => Math.max(1, n)} onChange={(max) => setMemory((m) => ({ ...m, max }))} aria-label="Maximum memory in GB" />
              GB
            </div>
          </SettingsRow>
        </SettingsCard>
        {clashes.length > 0 && (
          <Alert variant="error">
            <AlertTitle>Clashes with a server you already added</AlertTitle>
            <AlertDescription>
              <p>Both can't run at the same time until these differ:</p>
              <ul className="grid gap-0.5">
                {clashes.map((clash, i) => (
                  <li key={`${clash.label}-${i}`}>
                    <span className="font-medium text-foreground">{clash.label}:</span> {clash.detail}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="outline" onClick={() => setCandidate(null)}>
            <ChevronLeft />
            Back
          </Button>
          <Button onClick={() => void add()} disabled={adding || (!rconPassword && !candidate.hasRcon)}>
            {adding ? <Loader2 className="animate-spin" /> : <Plus />}
            Add server
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      {mounts.length > 0 && (
        <SettingsCard title="Found on this machine" description="Installs the panel can see, such as Docker mounts.">
          {mounts.map((mount) => (
            <DiscoveredInstall key={mount.installPath} mount={mount} onAdded={finish} />
          ))}
        </SettingsCard>
      )}

      {servers.length > 0 && (
        <Alert>
          <AlertTitle>Running a second server next to your first?</AlertTitle>
          <AlertDescription>
            Give it its own install folder (SteamCMD and Workshop downloads overwrite a shared one), its own data folder, a unique config name and RCON port, and a game port two
            higher than the other server's. SteamCMD itself is safe to share.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="scan">
        <TabsList>
          <TabsTab value="scan">Scan a folder</TabsTab>
          <TabsTab value="manual">Enter the data folder</TabsTab>
        </TabsList>
        <TabsPanel value="scan" className="grid gap-4 pt-4">
          <div className="flex gap-2">
            <div className="flex-1">
              <PathInput value={scanPath} onChange={setScanPath} browseTitle="Choose a folder to scan" placeholder="Folder that contains your servers" />
            </div>
            <Button onClick={() => void scan()} disabled={scanning || !scanPath.trim()}>
              {scanning ? <Loader2 className="animate-spin" /> : <Search />}
              Scan
            </Button>
          </div>
          {scanResult && scanResult.detectedConfigs.length > 0 && (
            <ul className="divide-y rounded-2xl border">
              {scanResult.detectedConfigs.map((config) => (
                <li key={config.serverName + config.dataPath}>
                  <button type="button" className="grid w-full gap-1 px-4 py-3 text-start text-sm hover:bg-accent" onClick={() => pickScanned(config)}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{config.publicName || config.serverName}</span>
                      <Badge variant="secondary" className="font-mono">
                        {config.serverName}.ini
                      </Badge>
                    </span>
                    <span className="truncate font-mono text-muted-foreground">{config.dataPath}</span>
                    <span className={config.matchedBatFile ? 'text-success-foreground' : 'text-warning-foreground'}>
                      {config.matchedBatFile
                        ? `Start script: ${config.matchedBatFile}`
                        : scanResult.installPaths.length > 0
                          ? 'No matching start script; the default install folder will be used.'
                          : 'No install folder found; enter it on the next screen.'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </TabsPanel>
        <TabsPanel value="manual" className="grid gap-4 pt-4">
          <SettingsCard title="Where is the server?">
            <SettingsRow label="Zomboid data folder" stacked description="The folder with Server/, Saves/ and Logs/ inside.">
              <PathInput
                value={dataPath}
                onChange={(value) => {
                  setDataPath(value)
                  setDetected(null)
                  setDetectError(null)
                }}
                browseTitle="Choose the data folder"
                placeholder="Path to the Zomboid data folder"
              />
            </SettingsRow>
            <SettingsRow label="Install folder" stacked description={runtimeInfo?.family === 'windows' ? 'Optional. The folder with StartServer64.bat.' : 'Optional. The folder with start-server.sh.'}>
              <PathInput value={installPath} onChange={setInstallPath} browseTitle="Choose the install folder" placeholder="Optional" />
            </SettingsRow>
            <div className="flex justify-end py-4">
              <Button onClick={() => void detect()} disabled={detecting || !dataPath.trim()}>
                {detecting ? <Loader2 className="animate-spin" /> : <Search />}
                Find the server
              </Button>
            </div>
          </SettingsCard>
          {detectError && (
            <Alert variant="error">
              <AlertTitle>Nothing found</AlertTitle>
              <AlertDescription>{detectError}</AlertDescription>
            </Alert>
          )}
          {detected && detected.servers.length === 0 && (
            <Alert variant="warning">
              <AlertTitle>No server config in that folder</AlertTitle>
              <AlertDescription>Start the server once so it creates its .ini file, then try again.</AlertDescription>
            </Alert>
          )}
          {detected && detected.servers.length > 1 && (
            <ul className="divide-y rounded-2xl border">
              {detected.servers.map((server) => (
                <li key={server.serverName}>
                  <button type="button" className="flex w-full items-center justify-between gap-2 px-4 py-3 text-start text-sm hover:bg-accent" onClick={() => pickDetected(server)}>
                    <span className="font-medium">{server.publicName || server.serverName}</span>
                    <span className="text-muted-foreground">{server.serverName}.ini</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </TabsPanel>
      </Tabs>

      <div>
        <Button variant="outline" onClick={onExit}>
          <ChevronLeft />
          Choose another way
        </Button>
      </div>
    </div>
  )
}
