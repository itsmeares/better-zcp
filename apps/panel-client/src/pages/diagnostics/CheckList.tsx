import type { ReactNode } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, MinusCircle, RefreshCw } from 'lucide-react'
import type { DiagnosticCheck, DiagnosticStatus, DiagnosticSummary } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Toggle } from '@/components/ui/toggle'

const STATUS_ICON: Record<DiagnosticStatus, { icon: typeof Info; className: string }> = {
  fail: { icon: AlertCircle, className: 'text-destructive' },
  warn: { icon: AlertTriangle, className: 'text-warning' },
  ok: { icon: CheckCircle2, className: 'text-success' },
  info: { icon: Info, className: 'text-info' },
  skip: { icon: MinusCircle, className: 'text-muted-foreground' },
}

export const isProblem = (check: DiagnosticCheck) => check.status === 'fail' || check.status === 'warn'

export function CheckList({ checks }: { checks: DiagnosticCheck[] }) {
  return (
    <ul className="divide-y">
      {checks.map((check) => {
        const { icon: Icon, className } = STATUS_ICON[check.status]
        return (
          <li key={check.id} className="flex items-start gap-3 py-2.5">
            <Icon className={cn('mt-0.5 size-4 shrink-0', className)} />
            <div className="grid min-w-0 gap-0.5 text-sm">
              <span className="font-medium">
                {check.label}
                {check.status === 'skip' && <span className="font-normal text-muted-foreground"> (skipped)</span>}
              </span>
              <p className="wrap-break-word text-muted-foreground">{check.message}</p>
              {check.hint && (
                <p>
                  <span className="font-medium">Fix: </span>
                  {check.hint}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

const OVERALL = {
  ok: { icon: CheckCircle2, className: 'text-success' },
  warn: { icon: AlertTriangle, className: 'text-warning' },
  fail: { icon: AlertCircle, className: 'text-destructive' },
}

/** The headline card for a set of checks: overall result, counts, and the controls. */
export function ReportHeader({
  report,
  title,
  fetching,
  onRerun,
  onlyProblems,
  onOnlyProblemsChange,
  actions,
}: {
  report: { overall: 'ok' | 'warn' | 'fail'; summary: DiagnosticSummary; timestamp: string; durationMs: number }
  title: string
  fetching: boolean
  onRerun: () => void
  onlyProblems: boolean
  onOnlyProblemsChange: (value: boolean) => void
  actions?: ReactNode
}) {
  const { icon: Icon, className } = OVERALL[report.overall]
  const { summary } = report
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className={cn('size-5', className)} />
          {title}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          <Badge variant="success">{summary.ok} passed</Badge>
          {summary.warn > 0 && <Badge variant="warning">{summary.warn} warnings</Badge>}
          {summary.fail > 0 && <Badge variant="error">{summary.fail} failed</Badge>}
          {summary.skip > 0 && <Badge variant="outline">{summary.skip} skipped</Badge>}
          <span>
            Checked at {new Date(report.timestamp).toLocaleTimeString('en')} in {report.durationMs} ms. Runs again every 30 seconds.
          </span>
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          {actions}
          <Toggle size="sm" variant="outline" pressed={onlyProblems} onPressedChange={onOnlyProblemsChange}>
            Only problems
          </Toggle>
          <Button size="sm" variant="outline" onClick={onRerun} disabled={fetching}>
            {fetching ? <Spinner /> : <RefreshCw />}
            Run again
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  )
}

export function ReportError({ title, error, retrying, onRetry }: { title: string; error: unknown; retrying: boolean; onRetry: () => void }) {
  return (
    <Alert variant="error">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{getUserErrorMessage(error, 'Check that the panel is running and you are still signed in.')}</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" onClick={onRetry} disabled={retrying}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  )
}

export function ReportLoading({ label }: { label: string }) {
  return (
    <Card className="flex-row items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </Card>
  )
}
