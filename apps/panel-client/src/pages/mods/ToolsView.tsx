import { useState } from 'react'
import { RefreshCw, Wrench } from 'lucide-react'
import { modsApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { notify } from './modsShared'
import type { ModsData } from './useModsData'

/** Reads mod.info from downloaded mods and adds their IDs to Mods=. Shared by Tools and the Add dialog. */
export async function syncModIds(data: ModsData) {
  try {
    const result = await modsApi.syncModIds()
    const synced = result.syncedMods?.filter((mod: { status?: string }) => mod.status?.startsWith('added')).length || 0
    const missing = result.missingMods?.length || 0
    if (synced > 0 || missing > 0) notify('Mod IDs synced', `${synced} added to the config.${missing ? ` ${missing} not downloaded yet.` : ''}`, 'success')
    else notify('Already in sync', 'Every downloaded mod is already in Mods=.')
    void data.fetchData()
  } catch (error) {
    notify("Couldn't sync mod IDs", getUserErrorMessage(error, 'Try again.'), 'error')
  }
}

export function ToolsView({ data }: { data: ModsData }) {
  const { iniConfig } = data
  const [syncing, setSyncing] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [repair, setRepair] = useState<{ removed: string[]; added?: string[]; message: string } | null>(null)

  const repairMaps = async () => {
    setRepairing(true)
    try {
      setRepair(await modsApi.repairMapEntries())
      void data.fetchData()
    } catch (error) {
      reportClientError('Map repair failed.', error)
      setRepair({ removed: [], message: "Map repair failed. Check the server connection." })
    } finally {
      setRepairing(false)
    }
  }

  return (
    <div className="grid gap-4">
      <SettingsCard title="Repairs" description="Fixes for a config that has drifted from what's on disk.">
        <SettingsRow label="Sync mod IDs from downloads" description="Reads mod.info in each downloaded mod and adds missing IDs to Mods=. Use it after Steam finishes downloading new mods.">
          <Button
            variant="outline"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true)
              await syncModIds(data)
              setSyncing(false)
            }}
          >
            {syncing ? <Spinner /> : <RefreshCw />}
            Sync mod IDs
          </Button>
        </SettingsRow>
        <SettingsRow label="Repair Maps=" description="Removes map entries no installed mod provides, and adds ones that are missing.">
          <Button variant="outline" disabled={repairing} onClick={() => void repairMaps()}>
            {repairing ? <Spinner /> : <Wrench />}
            Repair
          </Button>
        </SettingsRow>
        {repair && (
          <Alert className="my-3" variant={repair.removed.length || repair.added?.length ? 'warning' : 'success'}>
            <AlertDescription>{repair.message}</AlertDescription>
          </Alert>
        )}
      </SettingsCard>

      <SettingsCard title={`Maps= (${iniConfig?.maps.length ?? 0})`} description="The map folders the server loads, in order.">
        <div className="flex flex-wrap gap-1.5">
          {(iniConfig?.maps ?? []).map((map, index) => (
            <Badge key={`${map}-${index}`} variant="secondary">
              {map}
            </Badge>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title={`WorkshopItems= (${iniConfig?.workshopIds.length ?? 0})`} description="The Workshop items Steam downloads for the server.">
        <p className="max-h-32 overflow-y-auto rounded-lg bg-muted p-2 font-mono text-xs break-all text-muted-foreground">WorkshopItems={iniConfig?.workshopIds.join(';')}</p>
      </SettingsCard>

      <SettingsCard title="Good to know">
        <ul className="grid gap-2 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Load order matters.</span> Frameworks and dependencies have to load before the mods that use them, or things break without an error.
          </li>
          <li>
            <span className="font-medium text-foreground">Map mods need their folder names.</span> After adding one, check Maps= so spawns and cells load.
          </li>
          <li>
            <span className="font-medium text-foreground">Sync after new downloads.</span> A Workshop item with no mod IDs usually means Steam hasn't finished downloading it.
          </li>
        </ul>
      </SettingsCard>
    </div>
  )
}
