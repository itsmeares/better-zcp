import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { serversApi, serversDetectApi, type ServerInstance } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { toastManager } from '@/components/ui/toast'

export function isZomboidDataNestedInInstall(zomboidDataPath: string | null | undefined, installPath: string | null | undefined): boolean {
  if (!zomboidDataPath || !installPath) return false
  const normalize = (p: string) => p.replace(/[/\\]+$/, '').toLowerCase()
  const data = normalize(zomboidDataPath)
  const install = normalize(installPath)
  return data === install || data.startsWith(`${install}/`) || data.startsWith(`${install}\\`)
}

/** Removes a server from the panel, and optionally deletes its install folder. */
export function RemoveServerDialog({ server, onClose, onRemoved }: { server: ServerInstance | null; onClose: () => void; onRemoved: () => void }) {
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const dataInsideInstall = deleteFiles && isZomboidDataNestedInInstall(server?.zomboidDataPath, server?.installPath)

  const remove = async () => {
    if (!server) return
    setBusy(true)
    let filesDeleted = false
    try {
      if (deleteFiles && server.installPath) {
        try {
          const result = (await serversDetectApi.deleteFiles(server.installPath, server.id)) as { error?: string }
          if (result?.error) toastManager.add({ title: "Couldn't delete the files", description: result.error, type: 'error' })
          else filesDeleted = true
        } catch (error) {
          toastManager.add({
            title: "Couldn't delete the files",
            description: `${getUserErrorMessage(error, 'Could not delete server files.')} Removing it from the panel anyway.`,
            type: 'error',
          })
        }
      }
      await serversApi.delete(server.id)
      toastManager.add({ title: filesDeleted ? `${server.name} and its files were deleted` : `${server.name} was removed from the panel`, type: 'success' })
      setDeleteFiles(false)
      onRemoved()
    } catch (error) {
      toastManager.add({ title: "Couldn't remove the server", description: getUserErrorMessage(error, 'Failed to delete the server.'), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={server !== null}
      onOpenChange={(open) => {
        if (open || busy) return
        setDeleteFiles(false)
        onClose()
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {server?.name} from the panel?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteFiles ? 'The panel stops managing this server and deletes its install folder.' : "The panel stops managing this server. Its files stay where they are, so you can add it back later."}
          </AlertDialogDescription>
          {server?.installPath && (
            <label className="mt-3 flex items-start gap-3 rounded-lg border p-3 text-sm">
              <Checkbox checked={deleteFiles} disabled={busy} onCheckedChange={(checked) => setDeleteFiles(checked === true)} />
              <span className="grid gap-1">
                <span className="font-medium text-destructive-foreground">Also delete the server files</span>
                <span className="text-muted-foreground">
                  Permanently deletes everything in <code className="font-mono break-all">{server.installPath}</code>
                </span>
              </span>
            </label>
          )}
          {dataInsideInstall && (
            <Alert variant="error" className="mt-3">
              <AlertTitle>This also deletes the world save</AlertTitle>
              <AlertDescription>
                The Zomboid data folder (<code className="font-mono break-all">{server?.zomboidDataPath}</code>) is inside the install folder, so there's no
                separate copy. The panel refuses this until you move the data folder or back it up yourself.
              </AlertDescription>
            </Alert>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />} disabled={busy}>
            Cancel
          </AlertDialogClose>
          <Button variant={deleteFiles ? 'destructive' : 'default'} onClick={() => void remove()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? 'Removing…' : deleteFiles ? 'Delete everything' : 'Remove from panel'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}
