import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { SimTemplateApplyResult } from '@/lib/api'

interface TemplateApplyPanelProps {
  running: boolean | null
  scopeIni: boolean
  scopeSandbox: boolean
  onScopeIniChange: (v: boolean) => void
  onScopeSandboxChange: (v: boolean) => void
  applying: boolean
  applyError: string | null
  applyResult: SimTemplateApplyResult | null
  canManage: boolean
  canApply: boolean
  onApply: () => void
  onClose: () => void
}

export function TemplateApplyPanel({
  running,
  scopeIni,
  scopeSandbox,
  onScopeIniChange,
  onScopeSandboxChange,
  applying,
  applyError,
  applyResult,
  canManage,
  canApply,
  onApply,
  onClose,
}: TemplateApplyPanelProps) {
  const { t } = useTranslation('templateApplyPanel')
  if (!canManage) return null

  if (applyResult) {
    return (
      <Alert variant="success">
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>{t('appliedTitle')}</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            {applyResult.ini ? t('iniKeysUpdated', { count: applyResult.ini.appliedKeys.length }) : ''}
            {applyResult.sandbox && 'applied' in applyResult.sandbox
              ? t('sandboxSettingsUpdated', { count: applyResult.sandbox.applied.length })
              : ''}
            {applyResult.backups.length > 0 && t('backupFilesCreated', { count: applyResult.backups.length })}
          </p>
          <p className="font-medium">{t('effectNextRestart')}</p>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-3 border-t border-border/50 pt-3">
      {running !== false && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{running ? t('serverRunning') : t('serverStateUnavailable')}</AlertTitle>
          <AlertDescription>
            {running
              ? t('stopBeforeApplying')
              : t('confirmStoppedRetry')}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-2">
          <Checkbox id="scope-sandbox" checked={scopeSandbox} onCheckedChange={(v) => onScopeSandboxChange(v === true)} />
          <Label htmlFor="scope-sandbox" className="text-sm font-normal">{t('applySandboxChanges')}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="scope-ini" checked={scopeIni} onCheckedChange={(v) => onScopeIniChange(v === true)} />
          <Label htmlFor="scope-ini" className="text-sm font-normal">{t('applyIniChanges')}</Label>
        </div>
      </div>

      {applyError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('applyFailedTitle')}</AlertTitle>
          <AlertDescription>{applyError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={applying}>
          {t('cancel')}
        </Button>
        <Button onClick={onApply} disabled={applying || running !== false || !canApply || (!scopeIni && !scopeSandbox)}>
          {applying && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('applyTemplate')}
        </Button>
      </div>
    </div>
  )
}
