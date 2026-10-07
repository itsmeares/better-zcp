import { useContext, useEffect, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { serverApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { SocketContext } from '@/contexts/SocketContext'
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
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { toastManager } from '@/components/ui/toast'

const TARGETS = [
  { key: 'map', label: 'Map and terrain', detail: 'Chunks, terrain, buildings, zombie population, iso regions.' },
  { key: 'players', label: 'Players and vehicles', detail: 'Player saves, inventories, positions, vehicle data.' },
  { key: 'world', label: 'World state', detail: 'World dictionary, metadata, erosion, game object states, radio.' },
  { key: 'accounts', label: 'Accounts and bans', detail: 'User accounts, passwords, roles, whitelist and ban lists. Everyone registers again on their next join.' },
] as const

const PREVIEW_LABELS: Record<string, string> = {
  map: 'map and terrain',
  players: 'player and vehicle',
  world: 'world state',
  leftovers: 'other leftover',
  accounts: 'account database',
}

interface WipePreview {
  totalFiles: number
  totalSize: number
  preview: Record<string, { files: number; size: number }>
  truncated?: boolean
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Deletes chosen parts of the save. Always previews first; backs up first unless the admin opts out. */
export function WipeServerDialog({ open, onOpenChange, serverName }: { open: boolean; onOpenChange: (open: boolean) => void; serverName: string }) {
  const socket = useContext(SocketContext)
  const [targets, setTargets] = useState<Record<string, boolean>>({ map: true, players: true, world: true, accounts: false })
  const [backupFirst, setBackupFirst] = useState(true)
  const [preview, setPreview] = useState<WipePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ phase: string; percent: number; message: string } | null>(null)
  const selected = Object.entries(targets).filter(([, on]) => on).map(([key]) => key)

  useEffect(() => {
    if (!socket || !busy) return
    const onProgress = (data: { phase: string; percent: number; message: string }) => setProgress(data)
    socket.on('backup:progress', onProgress)
    return () => {
      socket.off('backup:progress', onProgress)
    }
  }, [socket, busy])

  const close = (next: boolean) => {
    if (busy) return
    if (!next) setPreview(null)
    onOpenChange(next)
  }

  const runPreview = async () => {
    setBusy(true)
    try {
      setPreview(await serverApi.wipePreview(selected))
    } catch (error) {
      toastManager.add({ title: "Couldn't preview the wipe", description: getUserErrorMessage(error, "The panel couldn't scan the save folder."), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const wipe = async () => {
    setBusy(true)
    setProgress(backupFirst ? { phase: 'preparing', percent: 0, message: 'Starting the backup…' } : null)
    try {
      const result = await serverApi.wipe(selected, backupFirst)
      toastManager.add({
        title: 'Server wiped',
        description: `Deleted: ${selected.join(', ')}.${result.backupCreated ? ` Backed up first as ${result.backupName || 'a new backup'}.` : ''}`,
        type: 'success',
      })
      setPreview(null)
      onOpenChange(false)
    } catch (error) {
      toastManager.add({ title: 'Wipe failed', description: getUserErrorMessage(error, 'Unknown error.'), type: 'error' })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Wipe {serverName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Choose what to delete. The server must be stopped. Server .ini and sandbox settings are kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2 px-6">
          {TARGETS.map((target) => (
            <label key={target.key} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:checked]:bg-accent">
              <Checkbox
                checked={targets[target.key]}
                disabled={busy}
                onCheckedChange={(checked) => {
                  setTargets((prev) => ({ ...prev, [target.key]: checked === true }))
                  setPreview(null)
                }}
              />
              <span className="grid gap-0.5">
                <span className="font-medium">{target.label}</span>
                <span className="text-muted-foreground">{target.detail}</span>
              </span>
            </label>
          ))}
          <label className="mt-2 flex items-start justify-between gap-4 text-sm">
            <span className="grid gap-0.5">
              <span className="font-medium">Back up before wiping</span>
              <span className="text-muted-foreground">Saves the current world (and the accounts database, if selected) first. Restore it from Backups.</span>
            </span>
            <Switch checked={backupFirst} disabled={busy} onCheckedChange={setBackupFirst} />
          </label>
          {!backupFirst && (
            <Alert variant="error">
              <AlertTitle>No backup will be made</AlertTitle>
              <AlertDescription>Whatever you wipe is gone for good. The panel can't undo it.</AlertDescription>
            </Alert>
          )}
          {busy && progress && progress.phase !== 'complete' && (
            <Progress value={progress.percent}>
              <span className="text-sm text-muted-foreground">{progress.message}</span>
              <ProgressTrack>
                <ProgressIndicator />
              </ProgressTrack>
            </Progress>
          )}
          {preview && (
            <Alert variant={preview.totalFiles === 0 ? 'default' : 'error'}>
              <AlertTitle>{preview.totalFiles === 0 ? 'Nothing to delete' : 'This permanently deletes'}</AlertTitle>
              {preview.totalFiles > 0 && (
                <AlertDescription>
                  <ul className="grid gap-0.5">
                    {['map', 'players', 'world', 'leftovers', 'accounts'].map((key) => {
                      const data = preview.preview?.[key]
                      if (!data || (key === 'leftovers' && data.files === 0)) return null
                      return (
                        <li key={key}>
                          {data.files > 0 ? `${data.files.toLocaleString('en')} ${PREVIEW_LABELS[key]} files (${megabytes(data.size)})` : `No ${PREVIEW_LABELS[key]} files found`}
                        </li>
                      )
                    })}
                    <li className="font-medium text-foreground">
                      Total: {preview.totalFiles.toLocaleString('en')} files ({megabytes(preview.totalSize)})
                    </li>
                  </ul>
                  {preview.truncated && <p>The scan stopped early on a very large save, so the real numbers may be higher.</p>}
                </AlertDescription>
              )}
            </Alert>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />} disabled={busy}>
            Cancel
          </AlertDialogClose>
          {!preview ? (
            <Button variant="outline" disabled={selected.length === 0 || busy} onClick={() => void runPreview()}>
              {busy && <Loader2 className="animate-spin" />}
              Preview
            </Button>
          ) : (
            <Button variant="destructive" disabled={busy || preview.totalFiles === 0} onClick={() => void wipe()}>
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Wipe now
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}
