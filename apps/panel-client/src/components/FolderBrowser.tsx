import { useState, useEffect, useCallback } from 'react'
import {
  Folder,
  HardDrive,
  ChevronRight,
  ArrowUp,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { serverApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'

interface DirEntry {
  name: string
  path: string
  label?: string
  isDrive?: boolean
}

interface FolderBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
  initialPath?: string
  title?: string
}

export function FolderBrowser({
  open,
  onOpenChange,
  onSelect,
  initialPath,
  title,
}: FolderBrowserProps) {
  const resolvedTitle = title ?? 'Select Folder'
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDirectory = useCallback(async (dirPath?: string) => {
    setLoading(true)
    setError(null)
    setSelectedPath(null)
    try {
      const data = await serverApi.listDirectory(dirPath)
      setEntries(data.entries)
      setCurrentPath(data.currentPath)
      setParentPath(data.parentPath)
      setPathInput(data.currentPath || '')
    } catch (e) {
      setError(getUserErrorMessage(e, 'Failed to read directory'))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      loadDirectory(initialPath || undefined)
    }
  }, [open, initialPath, loadDirectory])

  const handleNavigate = (path: string) => {
    loadDirectory(path)
  }

  const handleSelect = (entry: DirEntry) => {
    if (entry.isDrive) {
      handleNavigate(entry.path)
      return
    }
    setSelectedPath(entry.path)
    setPathInput(entry.path)
  }

  const handleDoubleClick = (entry: DirEntry) => {
    handleNavigate(entry.path)
  }

  const handleConfirm = () => {
    const finalPath = selectedPath || currentPath
    if (finalPath) {
      onSelect(finalPath)
      onOpenChange(false)
    }
  }

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (pathInput.trim()) {
      loadDirectory(pathInput.trim())
    }
  }

  const handleGoUp = () => {
    if (parentPath) {
      loadDirectory(parentPath)
    } else {
      loadDirectory(undefined)
    }
  }

  const isDriveList = currentPath === null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="gap-0 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{resolvedTitle}</DialogTitle>
          <DialogDescription>Folders on the machine the panel runs on. Double-click to open one.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handlePathSubmit} className="flex items-center gap-2 border-y bg-muted/40 px-4 py-2">
          <Button type="button" variant="ghost" size="icon-sm" onClick={handleGoUp} disabled={isDriveList || loading} aria-label="Go up a folder">
            <ArrowUp />
          </Button>
          <Input value={pathInput} onChange={(e) => setPathInput(e.target.value)} placeholder={isDriveList ? 'This PC' : 'Type a path'} className="font-mono" aria-label="Path" />
          <Button type="submit" variant="ghost" size="sm" disabled={loading}>
            Go
          </Button>
        </form>
        <div className="h-80 overflow-y-auto">
          {loading ? (
            <div className="grid h-full place-items-center">
              <Spinner />
            </div>
          ) : error ? (
            <div className="grid h-full place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
              <AlertCircle className="size-5 text-destructive-foreground" />
              <p>{error}</p>
              <Button variant="ghost" size="sm" onClick={() => loadDirectory(undefined)}>
                Back to drives
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="grid h-full place-content-center justify-items-center gap-1 text-sm text-muted-foreground">
              <Folder className="size-5" />
              Empty folder
            </div>
          ) : (
            <div className="py-1">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={cn('flex w-full items-center gap-3 px-4 py-1.5 text-start text-sm hover:bg-accent', selectedPath === entry.path && 'bg-accent')}
                  onClick={() => handleSelect(entry)}
                  onDoubleClick={() => handleDoubleClick(entry)}
                >
                  {entry.isDrive ? <HardDrive className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{entry.name}</span>
                    {entry.label && <span className="block truncate text-xs text-muted-foreground">{entry.label}</span>}
                  </span>
                  {!entry.isDrive && <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <DialogFooter className="items-center border-t">
          <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{selectedPath || currentPath || 'No folder picked'}</p>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button onClick={handleConfirm} disabled={!selectedPath && !currentPath}>
            Use this folder
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
