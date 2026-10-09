import { useContext, useEffect, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive } from 'lucide-react'
import { downloadFile } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { SocketContext } from '@/contexts/SocketContext'
import type { DiagnosticsTab } from '@/routes/diagnostics'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { toastManager } from '@/components/ui/toast'
import { ActivityPanel } from './ActivityPanel'
import { ChecksPanel, checksQuery } from './ChecksPanel'
import { CrashesPanel, crashesQuery } from './CrashesPanel'
import { HealthPanel } from './HealthPanel'
import { MapPanel } from './MapPanel'
import { PanelLogPanel } from './PanelLogPanel'

function SupportBundleButton() {
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setBusy(true)
    try {
      await downloadFile('/debug/logs/download-zip', `pz-panel-logs-${new Date().toISOString().split('T')[0]}.zip`)
      toastManager.add({
        title: 'Support bundle downloaded',
        description: "It holds real logs. Known password and token shapes are blanked out, but that's no guarantee. Read it before you share it outside your team.",
        type: 'success',
      })
    } catch (error) {
      toastManager.add({ title: "Couldn't build the support bundle", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button onClick={() => void download()} disabled={busy}>
      {busy ? <Spinner /> : <Archive />}
      {busy ? 'Bundling…' : 'Download support bundle'}
    </Button>
  )
}

export default function DiagnosticsPage() {
  const { tab = 'checks' } = useSearch({ from: '/diagnostics' })
  const navigate = useNavigate({ from: '/diagnostics' })
  const queryClient = useQueryClient()
  const socket = useContext(SocketContext)
  const checks = useQuery(checksQuery).data
  const crashes = useQuery(crashesQuery).data
  const problems = checks ? checks.summary.fail + checks.summary.warn : 0
  const crashCount = crashes?.crashLogs.length ?? 0

  // A changed server list can move paths and RCON settings the checks read.
  useEffect(() => {
    if (!socket) return
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ['diagnostics'] })
    socket.on('servers:changed', refresh)
    return () => {
      socket.off('servers:changed', refresh)
    }
  }, [socket, queryClient])

  const setTab = (next: DiagnosticsTab) => void navigate({ search: { tab: next === 'checks' ? undefined : next }, replace: true })

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Diagnostics"
        description="Checks, recent activity, the panel's own log and crash dumps. The support bundle collects all of it in one file."
        actions={<SupportBundleButton />}
      />
      <Tabs value={tab} onValueChange={(value) => setTab(value as DiagnosticsTab)} className="min-w-0 gap-4">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTab value="checks">
            Checks
            {problems > 0 && <Badge variant={checks?.summary.fail ? 'error' : 'warning'}>{problems}</Badge>}
          </TabsTab>
          <TabsTab value="activity">Activity</TabsTab>
          <TabsTab value="log">Panel log</TabsTab>
          <TabsTab value="crashes">
            Crashes
            {crashCount > 0 && <Badge variant="secondary">{crashCount}</Badge>}
          </TabsTab>
          <TabsTab value="map">Map</TabsTab>
          <TabsTab value="health">Panel health</TabsTab>
        </TabsList>
        <TabsPanel value="checks">
          <ChecksPanel />
        </TabsPanel>
        <TabsPanel value="activity">
          <ActivityPanel />
        </TabsPanel>
        <TabsPanel value="log">
          <PanelLogPanel />
        </TabsPanel>
        <TabsPanel value="crashes">
          <CrashesPanel />
        </TabsPanel>
        <TabsPanel value="map">
          <MapPanel />
        </TabsPanel>
        <TabsPanel value="health">
          <HealthPanel />
        </TabsPanel>
      </Tabs>
    </div>
  )
}
