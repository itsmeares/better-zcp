import { useQuery } from '@tanstack/react-query'
import { schedulerApi } from '@/lib/api'
import { getSelectedServerId } from '@/lib/serverSelection'
import { Button } from '@/components/ui/button'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { getUserErrorMessage } from '@/lib/errorMessage'

export function MaintenanceNotice() {
  const { toast } = useToast()
  const { data, refetch } = useQuery({ queryKey: ['maintenance'], queryFn: schedulerApi.getStatus, enabled: Boolean(getSelectedServerId()), refetchInterval: 5000 })
  const active = data?.maintenance
  if (!active) return null
  const descriptions: Record<string, string> = {
    waiting: 'Waiting for players before maintenance. You can cancel before the server stops.',
    countdown: 'Players are receiving the warning countdown.', saving: 'Saving the world before stopping.',
    stopping: 'Waiting for the server to stop.', working: 'The server is stopped while maintenance runs.', starting: 'Starting the server again.',
  }
  return <Alert role="status" className="mb-4">
    <AlertTitle>{active.label}</AlertTitle>
    <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
      <span>{descriptions[active.phase] || active.phase}</span>
      {['waiting', 'countdown'].includes(active.phase) && <Button size="sm" variant="outline" onClick={async () => {
        try { await schedulerApi.cancelMaintenance(); await refetch() }
        catch (error) { toast({ title: 'Could not cancel maintenance', description: getUserErrorMessage(error, 'The server may already be stopping.'), variant: 'destructive' }) }
      }}>Cancel pending maintenance</Button>}
    </AlertDescription>
  </Alert>
}
