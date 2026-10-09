import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { serverApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { getInstallProgressMessage } from '@/lib/installProgressMessage'
import { useRuntimeInfo } from '@/hooks/useRuntimeInfo'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toastManager } from '@/components/ui/toast'
import { PathInput, registerServer, ReviewList, ServerSettingsFields, SetupComplete, SetupLog, useNewServerForm, Wizard, type SetupLogLine } from './shared'

/** Generates config and start scripts for server files that are already downloaded. */
export function SetupFilesFlow({ onExit }: { onExit: () => void }) {
  const runtimeInfo = useRuntimeInfo()
  const state = useNewServerForm()
  const { form, set, settingsProblem } = state
  const [step, setStep] = useState(0)
  const [working, setWorking] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const complete = created !== null
  const [logs, setLogs] = useState<SetupLogLine[]>([])
  const log = (line: SetupLogLine) => setLogs((prev) => [...prev, line])
  const startScript = runtimeInfo?.family === 'windows' ? 'StartServer64.bat' : 'start-server.sh'

  const create = async () => {
    if (settingsProblem) return
    setWorking(true)
    setCreated(null)
    setLogs([{ type: 'info', message: 'Creating the server configuration…' }])
    try {
      const data = await serverApi.quickSetup({
        installPath: form.installPath,
        serverName: form.serverName,
        zomboidDataPath: form.useCustomDataPath ? form.zomboidDataPath : null,
        minMemory: form.minMemory,
        maxMemory: form.maxMemory,
        adminPassword: form.adminPassword || null,
        serverPort: form.serverPort,
        useUpnp: form.useUpnp,
        useNoSteam: form.useNoSteam,
        useDebug: form.useDebug,
        rconPassword: form.rconPassword,
        rconPort: form.rconPort,
      })
      log({ type: 'success', message: 'Configuration created.' })
      for (const warning of (data.warnings ?? []) as Array<{ progressCode?: string; message: string; params?: Record<string, string | number> }>) {
        log({ type: 'warning', message: getInstallProgressMessage(warning, warning.message) })
      }
      const id = await registerServer(
        {
          name: data.serverName || form.serverName,
          serverName: data.serverName || form.serverName,
          installPath: data.installPath || form.installPath,
          zomboidDataPath: data.zomboidDataPath || null,
          serverConfigPath: data.serverConfigPath || null,
          rconHost: '127.0.0.1',
          rconPort: data.rconPort || form.rconPort,
          rconPassword: data.rconPassword || form.rconPassword,
          adminPassword: form.adminPassword,
          serverPort: data.serverPort || form.serverPort,
          minMemory: data.minMemory || form.minMemory,
          maxMemory: data.maxMemory || form.maxMemory,
          useNoSteam: form.useNoSteam,
          useDebug: form.useDebug,
          useUpnp: form.useUpnp,
        },
        log,
      )
      if (id !== null) setCreated(id)
    } catch (error) {
      const message = getUserErrorMessage(error, 'Unexpected error while creating the server.')
      log({ type: 'error', message })
      toastManager.add({ title: "The server wasn't created", description: message, type: 'error' })
    } finally {
      setWorking(false)
    }
  }

  const canProceed = [form.installPath.length > 0, form.serverName.length > 0 && !settingsProblem, true][step]
  const blocker = [!form.installPath ? 'Choose the server files folder.' : null, !form.serverName.trim() ? 'Enter a server name.' : settingsProblem, null][step]

  return (
    <Wizard steps={['Files', 'Settings', 'Create']} step={step} onStep={setStep} onExit={onExit} canProceed={canProceed} blocker={blocker} busy={working || complete}>
      {step === 0 && (
        <SettingsCard title="Server files" description={`The folder that already holds the dedicated server, with ${startScript} and the java folder inside.`}>
          <SettingsRow label="Folder" stacked>
            <PathInput value={form.installPath} onChange={(value) => set('installPath', value)} browseTitle="Choose the server files folder" placeholder="Existing dedicated server folder" />
          </SettingsRow>
        </SettingsCard>
      )}

      {step === 1 && (
        <div className="grid gap-4">
          <SettingsCard title="Server">
            <SettingsRow label="Server name" description="Letters, numbers and underscores. It names the config file, such as myserver.ini.">
              <Input className="w-56 font-mono" value={form.serverName} maxLength={64} onChange={(e) => set('serverName', e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} />
            </SettingsRow>
          </SettingsCard>
          <ServerSettingsFields state={state} />
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-4">
          <ReviewList
            rows={[
              ['Server files', form.installPath],
              ['Server name', form.serverName],
              ['Memory', `${form.minMemory}–${form.maxMemory} GB`],
              ['Game port', String(form.serverPort)],
              ['RCON port', String(form.rconPort)],
            ]}
          />
          {!complete && (
            <Button size="lg" onClick={() => void create()} disabled={working || Boolean(settingsProblem)}>
              {working ? <Loader2 className="animate-spin" /> : <Plus />}
              {working ? 'Creating…' : 'Create the server'}
            </Button>
          )}
          <SetupLog lines={logs} running={working} />
          {created !== null && <SetupComplete title="Server created" serverId={created} />}
        </div>
      )}
    </Wizard>
  )
}
