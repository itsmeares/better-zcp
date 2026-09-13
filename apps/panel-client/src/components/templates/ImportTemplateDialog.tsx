import { useRef, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { templatesApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'

interface ImportTemplateDialogProps {
  open: boolean
  onClose: () => void
  onImported: () => void
}

export function ImportTemplateDialog({
  open,
  onClose,
  onImported,
}: ImportTemplateDialogProps) {
  const { toast } = useToast()
  const [text, setText] = useState('')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    try {
      setText(await file.text())
    } catch (err) {
      setError(getUserErrorMessage(err, "Couldn't read that file."))
    }
  }

  const handleImport = async () => {
    setImporting(true)
    setError(null)
    try {
      const parsed = JSON.parse(text)
      const result = await templatesApi.import(parsed)
      if (!result.success)
        throw new Error(result.error || 'Failed to import template')
      toast({
        title: 'Template Imported',
        description:
          '"' +
          String(result.template?.meta.name) +
          '" was added to your templates.',
        variant: 'success' as const,
      })
      setText('')
      onImported()
    } catch (err) {
      setError(
        err instanceof SyntaxError
          ? 'That file is not valid JSON.'
          : getUserErrorMessage(err, 'Failed to import template'),
      )
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{'Import Template'}</DialogTitle>
          <DialogDescription>
            {"Paste a .pztemplate.json file's contents, or pick a file below."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.pztemplate.json,application/json"
            className="hidden"
            onChange={(e) =>
              e.target.files?.[0] && handleFile(e.target.files[0])
            }
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="w-full"
          >
            <Upload className="h-4 w-4" />
            {'Choose File'}
          </Button>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Paste template JSON here'}
            rows={10}
            className="font-mono text-xs"
          />
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{'Import Failed'}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>
            {'Cancel'}
          </Button>
          <Button onClick={handleImport} disabled={importing || !text.trim()}>
            {importing && <Loader2 className="h-4 w-4 animate-spin" />}
            {'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
