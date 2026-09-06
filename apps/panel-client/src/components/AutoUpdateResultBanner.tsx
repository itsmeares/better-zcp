import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { updateApi, type AutoUpdateResult } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { getAutoUpdateReasonMessage, getAutoUpdateServerStateMessage, getAutoUpdateSuccessMessage } from '@/lib/autoUpdateResult'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'

// 2026-08-26: renders the outcome of the UNATTENDED automatic server
// update (apps/panel-server/services/updateChecker.js's runAutoUpdate()) -- the one
// panel-managed job that stops and restarts a live server with nobody
// reviewing the result. A live socket event alone only reaches whoever
// happens to be watching at that instant, which excludes the exact
// operator this feature exists for (enabled it and walked away), so this
// fetches the PERSISTED last result on mount instead. Dismissal is
// shared server-side state, not local -- see updateApi.dismissAutoUpdateResult's
// own comment for why a per-browser dismissal would be wrong here.
export function AutoUpdateResultBanner() {
  const { t } = useTranslation('dashboard')
  const { toast } = useToast()
  const [result, setResult] = useState<AutoUpdateResult | null>(null)
  const [dismissing, setDismissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    updateApi.getStatus()
      .then((status) => { if (!cancelled) setResult(status.lastAutoUpdateResult) })
      .catch(() => { /* keep no-banner state; this is best-effort */ })
    return () => { cancelled = true }
  }, [])

  const dismiss = useCallback(async () => {
    setDismissing(true)
    try {
      const status = await updateApi.dismissAutoUpdateResult()
      setResult(status.lastAutoUpdateResult)
    } catch (error) {
      toast({
        title: t('autoUpdateResult.dismissFailedTitle'),
        description: getUserErrorMessage(error, t('autoUpdateResult.dismissFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setDismissing(false)
    }
  }, [t, toast])

  if (!result || result.dismissed) return null

  const isFailure = result.status === 'failed'

  return (
    <div
      role={isFailure ? 'alert' : 'status'}
      aria-live={isFailure ? 'assertive' : 'polite'}
      className={cn(
        'mb-3 flex items-start gap-3 rounded-md border px-3 py-2.5',
        isFailure ? 'border-destructive/35 bg-destructive/[0.05]' : 'border-success/35 bg-success/[0.05]'
      )}
    >
      {isFailure
        ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className={cn('text-sm font-medium', isFailure ? 'text-destructive' : 'text-success')}>
          {isFailure ? t('autoUpdateResult.failedTitle') : t('autoUpdateResult.successTitle')}
        </p>
        {isFailure && (
          <p className="text-sm font-medium text-foreground">
            {getAutoUpdateServerStateMessage(t, result.serverUp)}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {isFailure ? getAutoUpdateReasonMessage(t, result) : getAutoUpdateSuccessMessage(t, result)}
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        disabled={dismissing}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        aria-label={t('autoUpdateResult.dismissAria')}
        // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; disables only transiently while the dismiss action itself is in flight (self-evident, not a permission gate). Triaged 2026-08-27.
        title={t('autoUpdateResult.dismiss')}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
