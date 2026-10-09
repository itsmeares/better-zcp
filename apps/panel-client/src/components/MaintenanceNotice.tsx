import { useQuery } from '@tanstack/react-query'
import { Wrench } from 'lucide-react'
import { schedulerApi } from '@/lib/api'
import { getSelectedServerId } from '@/lib/serverSelection'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { toastManager } from '@/components/ui/toast'

const PHASE_DESCRIPTIONS: Record<string, string> = {
  waiting: 'Waiting for players before maintenance. You can cancel before the server stops.',
  countdown: 'Players are receiving the warning countdown.',
  saving: 'Saving the world before stopping.',
  stopping: 'Waiting for the server to stop.',
  working: 'The server is stopped while maintenance runs.',
  starting: 'Starting the server again.',
}

export function MaintenanceNotice() {
  const { data, refetch } = useQuery({
    queryKey: ['maintenance'],
    queryFn: schedulerApi.getStatus,
    enabled: Boolean(getSelectedServerId()),
    refetchInterval: 5000,
  })
  const active = data?.maintenance
  if (!active) return null

  const cancel = async () => {
    try {
      await schedulerApi.cancelMaintenance()
      await refetch()
    } catch (error) {
      toastManager.add({
        title: 'Could not cancel maintenance',
        description: getUserErrorMessage(error, 'The server may already be stopping.'),
        type: 'error',
      })
    }
  }

  return (
    <Alert variant="info" role="status">
      <Wrench aria-hidden />
      <AlertTitle>{active.label}</AlertTitle>
      <AlertDescription>{PHASE_DESCRIPTIONS[active.phase] || active.phase}</AlertDescription>
      {['waiting', 'countdown'].includes(active.phase) && (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={() => void cancel()}>
            Cancel pending maintenance
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}
