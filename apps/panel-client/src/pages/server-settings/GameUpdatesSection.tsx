import { useEffect, useState } from 'react'
import { Download, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { updateApi, type ServerInstance, type UpdateStatus } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useConfirm } from '@/contexts/ConfirmContext'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { SteamOperationDialog, type SteamOperationType } from '@/components/server/SteamOperationDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toastManager } from '@/components/ui/toast'

export function GameUpdatesSection({ server, isDirty }: { server: ServerInstance; isDirty: boolean }) {
  const confirm = useConfirm()
  const [updating, setUpdating] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null)
  const [gameVersion, setGameVersion] = useState<string | null>(null)
  const [steamOperation, setSteamOperation] = useState<SteamOperationType | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const status = await updateApi.getStatus()
        if (cancelled) return
        setUpdating(status.updating)
        setResult(status.lastUpdateResult?.message || null)
        setUpdateInfo(status.updateAvailable ?? null)
        setGameVersion(status.gameVersion ?? null)
      } catch (error) {
        reportClientError('Could not read game update status.', error)
      }
    }
    void refresh()
    const timer = setInterval(refresh, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const update = async () => {
    const ok = await confirm({
      title: 'Update the game server?',
      description:
        'The server saves and stops while SteamCMD updates its files, then starts again if it was running. If the update fails it stays stopped so you can check what happened. Online players get a 15-minute warning; an empty server updates right away.',
      confirmLabel: 'Save, stop and update',
      variant: 'warning',
    })
    if (!ok) return
    setUpdating(true)
    try {
      await updateApi.install()
      setResult('Saving and stopping the server before the update…')
    } catch (error) {
      setUpdating(false)
      toastManager.add({ title: 'Game update failed', description: getUserErrorMessage(error, "The update couldn't start."), type: 'error' })
    }
  }

  const build = updateInfo?.installed
  return (
    <SettingsCard
      title="Game updates"
      description="Other servers that share this install folder must be stopped first."
      action={updateInfo?.updateAvailable ? <Badge variant="warning">Build {updateInfo.latest.buildId} available</Badge> : undefined}
    >
      <SettingsRow
        label="Installed"
        description={
          [gameVersion && `Version ${gameVersion}`, build && `build ${build.buildId}`, build?.branch && `${build.branch} branch`].filter(Boolean).join(' · ') || 'Unknown'
        }
      >
        <Button onClick={() => void update()} disabled={updating || isDirty}>
          {updating ? <Loader2 className="animate-spin" /> : <Download />}
          {updating ? 'Update in progress' : 'Update game server'}
        </Button>
      </SettingsRow>
      {result && (
        <p role="status" className="border-b py-3 text-sm text-muted-foreground">
          {result}
        </p>
      )}
      <SettingsRow label="Run SteamCMD yourself" description="Pick a Steam branch, or check and repair the game files. The server must be stopped.">
        <Button variant="outline" size="sm" onClick={() => setSteamOperation('update')} disabled={updating}>
          <RefreshCw />
          Update…
        </Button>
        <Button variant="outline" size="sm" onClick={() => setSteamOperation('verify')} disabled={updating}>
          <ShieldCheck />
          Verify files…
        </Button>
      </SettingsRow>
      <SteamOperationDialog server={steamOperation ? server : null} type={steamOperation ?? 'update'} installedBranch={build?.branch} onClose={() => setSteamOperation(null)} />
    </SettingsCard>
  )
}
