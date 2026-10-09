import { useState } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { debugApi } from '@/lib/api'
import { EmptyState } from '@/components/EmptyState'
import { Card, CardAction, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { CheckList, isProblem, ReportError, ReportHeader, ReportLoading } from './CheckList'

export const checksQuery = queryOptions({
  queryKey: ['diagnostics', 'checks'],
  queryFn: debugApi.getDiagnostics,
  refetchInterval: 30_000,
  retry: false,
})

const TITLE = { ok: 'Everything looks fine', warn: 'A few things to look at', fail: 'Something needs attention' }

export function ChecksPanel() {
  const query = useQuery(checksQuery)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const report = query.data
  const rerun = () => void query.refetch()

  if (!report) {
    return query.isError ? (
      <ReportError title="Couldn't run the checks" error={query.error} retrying={query.isFetching} onRetry={rerun} />
    ) : (
      <ReportLoading label="Checking services, paths, storage and updates…" />
    )
  }

  const categories = Object.entries(report.categories)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([key, meta]) => ({
      key,
      label: meta.label,
      checks: report.checks.filter((check) => check.category === key && (!onlyProblems || isProblem(check))),
    }))
    .filter((category) => category.checks.length > 0)

  return (
    <div className="grid gap-4">
      {query.isError && <ReportError title="The last run failed, so these results are old" error={query.error} retrying={query.isFetching} onRetry={rerun} />}
      <ReportHeader
        report={report}
        title={TITLE[report.overall]}
        fetching={query.isFetching}
        onRerun={rerun}
        onlyProblems={onlyProblems}
        onOnlyProblemsChange={setOnlyProblems}
      />
      {categories.length === 0 ? (
        <EmptyState type="noResults" title="Nothing needs attention" description="Every check passed. Turn off Only problems to see them all." />
      ) : (
        categories.map((category) => (
          <Card key={category.key}>
            <CardHeader>
              <CardTitle className="text-base">{category.label}</CardTitle>
              <CardAction className="text-sm text-muted-foreground">{category.checks.length === 1 ? '1 check' : `${category.checks.length} checks`}</CardAction>
            </CardHeader>
            <CardPanel>
              <CheckList checks={category.checks} />
            </CardPanel>
          </Card>
        ))
      )}
    </div>
  )
}
