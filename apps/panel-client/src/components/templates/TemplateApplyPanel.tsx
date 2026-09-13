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
  if (!canManage) return null

  if (applyResult) {
    return (
      <Alert variant="success">
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>{'Template Applied'}</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            {applyResult.ini
              ? Number(applyResult.ini.appliedKeys.length) === 1
                ? String(applyResult.ini.appliedKeys.length) +
                  ' INI key updated. '
                : String(applyResult.ini.appliedKeys.length) +
                  ' INI keys updated. '
              : ''}
            {applyResult.sandbox && 'applied' in applyResult.sandbox
              ? Number(applyResult.sandbox.applied.length) === 1
                ? String(applyResult.sandbox.applied.length) +
                  ' sandbox setting updated. '
                : String(applyResult.sandbox.applied.length) +
                  ' sandbox settings updated. '
              : ''}
            {applyResult.backups.length > 0 &&
              (Number(applyResult.backups.length) === 1
                ? String(applyResult.backups.length) + ' backup file created. '
                : String(applyResult.backups.length) +
                  ' backup files created. ')}
          </p>
          <p className="font-medium">
            {'Changes will take effect the next time the server restarts.'}
          </p>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-3 border-t border-border/50 pt-3">
      {running !== false && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {running ? 'Server is running' : 'Server state unavailable'}
          </AlertTitle>
          <AlertDescription>
            {running
              ? 'Stop the server before applying this template.'
              : 'Confirm the server is stopped, then retry.'}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-2">
          <Checkbox
            id="scope-sandbox"
            checked={scopeSandbox}
            onCheckedChange={(v) => onScopeSandboxChange(v === true)}
          />
          <Label htmlFor="scope-sandbox" className="text-sm font-normal">
            {'Apply sandbox changes'}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="scope-ini"
            checked={scopeIni}
            onCheckedChange={(v) => onScopeIniChange(v === true)}
          />
          <Label htmlFor="scope-ini" className="text-sm font-normal">
            {'Apply server.ini changes'}
          </Label>
        </div>
      </div>

      {applyError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{'Apply Failed'}</AlertTitle>
          <AlertDescription>{applyError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={applying}>
          {'Cancel'}
        </Button>
        <Button
          onClick={onApply}
          disabled={
            applying ||
            running !== false ||
            !canApply ||
            (!scopeIni && !scopeSandbox)
          }
        >
          {applying && <Loader2 className="h-4 w-4 animate-spin" />}
          {'Apply Template'}
        </Button>
      </div>
    </div>
  )
}
