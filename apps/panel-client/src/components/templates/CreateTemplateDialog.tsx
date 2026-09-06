import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { serverFilesApi, templatesApi } from '@/lib/api'
import { buildTemplateCapture, TemplateCapture } from '@/lib/templateBuilder'
import { getUserErrorMessage } from '@/lib/errorMessage'

interface CreateTemplateDialogProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

export function CreateTemplateDialog({ open, onClose, onCreated }: CreateTemplateDialogProps) {
  const { t } = useTranslation('templateCreateDialog')
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [capture, setCapture] = useState<TemplateCapture | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setDescription('')
    setTags('')
    setError(null)
    setLoading(true)
    Promise.all([serverFilesApi.getIni(), serverFilesApi.getSandbox()])
      .then(([ini, sandbox]) => setCapture(buildTemplateCapture(ini.settings, sandbox.sandbox)))
      .catch(() => setError(t('failedToReadConfig')))
      .finally(() => setLoading(false))
  }, [open, t])

  const handleSave = async () => {
    if (!capture || !name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const result = await templatesApi.create({
        name: name.trim(),
        description: description.trim(),
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        serverIni: capture.serverIni,
        sandboxVars: capture.sandboxVars,
      })
      if (!result.success) throw new Error(result.error || t('failedToSave'))
      toast({ title: t('toastSavedTitle'), description: t('toastSavedDesc', { name: name.trim() }), variant: 'success' as const })
      onCreated()
    } catch (err) {
      setError(getUserErrorMessage(err, t('failedToSave')))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="template-name">{t('nameLabel')}</Label>
              <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="template-description">{t('descriptionLabel')}</Label>
              <Textarea id="template-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="template-tags">{t('tagsLabel')}</Label>
              <Input id="template-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('tagsPlaceholder')} />
            </div>
            {capture && (
              <p className="text-xs text-muted-foreground">
                {t('willSave', {
                  sandbox: t('sandboxSettingCount', { count: capture.sandboxKeyCount }),
                  ini: t('iniKeyCount', { count: capture.iniKeyCount }),
                })}
              </p>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertTitle>{t('errorTitle')}</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('cancel')}</Button>
          <Button onClick={handleSave} disabled={saving || loading || !name.trim() || !capture}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('saveTemplate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
