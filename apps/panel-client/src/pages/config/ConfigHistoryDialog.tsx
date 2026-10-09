import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { serverFilesApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useConfirm } from '@/contexts/ConfirmContext'
import { EmptyState } from '@/components/EmptyState'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { toastManager } from '@/components/ui/toast'
import { backupFileType, type ConfigFile } from './configFiles'

const TYPE_LABEL: Record<ConfigFile, string> = { ini: 'Server settings', sandbox: 'Sandbox', spawnpoints: 'Spawn points', spawnregions: 'Spawn regions' }

/** Copies the panel keeps of each config file before it writes a new version. */
export function ConfigHistoryDialog({
  open,
  onOpenChange,
  serverId,
  onRestored,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverId: string | number | null
  onRestored: () => void
}) {
  const confirm = useConfirm()
  const [filter, setFilter] = useState<'all' | ConfigFile>('all')
  const backups = useQuery({ queryKey: ['config', 'backups', serverId], queryFn: serverFilesApi.getBackups, enabled: open, retry: false })
  const list = (backups.data?.backups ?? []).filter((backup) => filter === 'all' || backupFileType(backup.filename) === filter)

  const restore = async (filename: string) => {
    const confirmed = await confirm({
      title: 'Restore this copy?',
      description: `The live file is replaced with ${filename}. Unsaved edits on this page are lost.`,
      confirmLabel: 'Restore',
    })
    if (!confirmed) return
    try {
      await serverFilesApi.restoreBackup(filename, serverId)
      toastManager.add({ title: 'Restored', description: filename, type: 'success' })
      onOpenChange(false)
      onRestored()
    } catch (error) {
      toastManager.add({ title: 'Restore failed', description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>File history</DialogTitle>
          <DialogDescription>The panel keeps a copy of each config file every time it saves. Restore one to undo a change.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-3">
          <Tabs value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
            <TabsList>
              <TabsTab value="all">All</TabsTab>
              {(Object.keys(TYPE_LABEL) as ConfigFile[]).map((type) => (
                <TabsTab key={type} value={type}>
                  {TYPE_LABEL[type]}
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>
          <div className="max-h-96 overflow-y-auto">
            {backups.isPending ? (
              <Skeleton className="h-32" />
            ) : backups.isError ? (
              <p className="text-sm text-destructive-foreground">{getUserErrorMessage(backups.error, 'The history could not be loaded.')}</p>
            ) : list.length === 0 ? (
              <EmptyState compact type="noData" title="No copies yet" description="One is kept every time you save a file." />
            ) : (
              <ul className="divide-y rounded-lg border">
                {list.map((backup) => {
                  const type = backupFileType(backup.filename)
                  return (
                    <li key={backup.filename} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm">
                          {type && <Badge variant="secondary">{TYPE_LABEL[type]}</Badge>}
                          <span className="truncate font-mono text-xs" title={backup.filename}>
                            {backup.filename}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(backup.created).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })} · {Math.max(1, Math.round(backup.size / 1024))} KB
                        </p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => void restore(backup.filename)}>
                        <RotateCcw />
                        Restore
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
