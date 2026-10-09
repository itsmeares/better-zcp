import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle, CheckCircle2, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { debugApi, gameIntegrationApi, type GameIntegrationPlayer, type MapDiagnostics } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { copyText } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { toastManager } from '@/components/ui/toast'
import { CheckList, isProblem, ReportError, ReportHeader, ReportLoading } from './CheckList'
import { CopyPath } from './CopyPath'

const TITLE = { ok: 'The map has everything it needs', warn: 'The map works, with warnings', fail: "The map can't show everything" }
const STATUS_ORDER = { fail: 0, warn: 1, info: 2, skip: 3, ok: 4 }

function reportText(report: MapDiagnostics) {
  const { map, save, summary } = report
  const folders = map?.available ? map.folders.map((folder) => folder.name + (folder.image ? '' : ' (outlines only)')).join(', ') : 'not found'
  return [
    `Map diagnostics, ${report.timestamp}`,
    `Overall: ${report.overall} (${summary.fail} failed, ${summary.warn} warnings, ${summary.ok} passed)`,
    '',
    `Map files: ${folders}`,
    ...(map?.warnings ?? []).map((warning) => `  ${warning}`),
    '',
    `Save: build=${save.build} count=${save.saveCount} active=${save.activeSaveName || 'none'}`,
    ...(save.zomboidDataPath ? [`  zomboidData=${save.zomboidDataPath}`] : []),
    '',
    'Checks:',
    ...report.checks.map((check) => `  [${check.status.toUpperCase()}] ${check.label}: ${check.message}${check.hint ? `  Fix: ${check.hint}` : ''}`),
  ].join('\n')
}

/** Reads player positions the same way the map does, and times it. */
async function probePlayers() {
  const started = performance.now()
  const raw: unknown = (await gameIntegrationApi.getAllPlayerDetails()).data?.players
  // Lua's JSON encoder can send a list as an object.
  const players = (Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : []) as GameIntegrationPlayer[]
  return { players, latencyMs: Math.round(performance.now() - started) }
}

export function MapPanel() {
  const query = useQuery({ queryKey: ['diagnostics', 'map'], queryFn: debugApi.getMapDiagnostics, refetchInterval: 30_000, retry: false })
  const probe = useQuery({ queryKey: ['diagnostics', 'map-players'], queryFn: probePlayers, refetchInterval: 20_000, retry: false })
  const [onlyProblems, setOnlyProblems] = useState(false)
  const report = query.data
  const rerun = () => void query.refetch()

  if (!report) {
    return query.isError ? (
      <ReportError title="Couldn't run the map checks" error={query.error} retrying={query.isFetching} onRetry={rerun} />
    ) : (
      <ReportLoading label="Checking map files and the active save…" />
    )
  }

  const checks = [...report.checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  const firstFix = checks.find(isProblem)
  const shown = onlyProblems ? checks.filter(isProblem) : checks
  const { map, save } = report

  const copyReport = async () => {
    const ok = await copyText(reportText(report))
    toastManager.add(ok ? { title: 'Report copied', type: 'success' } : { title: "Couldn't copy the report", description: 'The browser blocked clipboard access.', type: 'error' })
  }

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
        actions={
          <>
            <Button size="sm" variant="outline" render={<Link to="/map" search={{ x: undefined, y: undefined, z: undefined }} />}>
              <ExternalLink />
              Open map
            </Button>
            <Button size="sm" variant="outline" onClick={() => void copyReport()}>
              <Copy />
              Copy report
            </Button>
          </>
        }
      />

      {firstFix && (
        <Alert variant={firstFix.status === 'fail' ? 'error' : 'warning'}>
          {firstFix.status === 'fail' ? <AlertCircle /> : <AlertTriangle />}
          <AlertTitle>{firstFix.label}</AlertTitle>
          <AlertDescription>
            <p>{firstFix.message}</p>
            {firstFix.hint && <p className="text-foreground">Fix: {firstFix.hint}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Map files</CardTitle>
            <CardDescription>Drawn from the game files of each Map= entry, read on the panel's computer.</CardDescription>
          </CardHeader>
          <CardPanel className="grid gap-2 text-sm">
            {!map?.available ? (
              <p className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                {map?.warnings.join(' ') || 'No map folder was found for this server.'}
              </p>
            ) : (
              <>
                <ul className="divide-y">
                  {map.folders.map((folder) => (
                    <li key={folder.id} className="flex items-center gap-2 py-2">
                      <CheckCircle2 className="size-4 shrink-0 text-success" />
                      <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
                      <Badge variant="outline">{folder.source === 'workshop' ? 'Workshop' : 'Game'}</Badge>
                      <span className="text-muted-foreground">{folder.image ? 'Image and outlines' : 'Outlines only'}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground">
                  Floors {map.floors.min} to {map.floors.max}.
                </p>
                {map.warnings.map((warning) => (
                  <p key={warning} className="flex items-start gap-2 text-warning-foreground">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {warning}
                  </p>
                ))}
              </>
            )}
          </CardPanel>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Active save</CardTitle>
            <CardDescription>Whether the save uses the Build 42 map layout.</CardDescription>
          </CardHeader>
          <CardPanel>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Build</dt>
              <dd className="flex items-center gap-2">
                <Badge variant={save.build === 'b42' ? 'success' : 'outline'}>{save.build === 'b42' ? 'Build 42' : 'Unknown'}</Badge>
                <span className="text-muted-foreground">{save.saveCount === 1 ? '1 save' : `${save.saveCount} saves`}</span>
              </dd>
              {save.activeSaveName && (
                <>
                  <dt className="text-muted-foreground">Sample save</dt>
                  <dd className="font-mono text-xs leading-5">{save.activeSaveName}</dd>
                </>
              )}
              {save.zomboidDataPath && (
                <>
                  <dt className="text-muted-foreground">Zomboid data</dt>
                  <dd>
                    <CopyPath label="Zomboid data path" value={save.zomboidDataPath} />
                  </dd>
                </>
              )}
              {save.activeSavePath && (
                <>
                  <dt className="text-muted-foreground">Save folder</dt>
                  <dd>
                    <CopyPath label="Save path" value={save.activeSavePath} />
                  </dd>
                </>
              )}
            </dl>
          </CardPanel>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live player positions</CardTitle>
          <CardDescription>
            {probe.data
              ? `${probe.data.players.length === 1 ? '1 player' : `${probe.data.players.length} players`} in ${probe.data.latencyMs} ms, checked at ${new Date(probe.dataUpdatedAt).toLocaleTimeString('en')}.`
              : 'The live player data the map draws.'}
          </CardDescription>
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => void probe.refetch()} disabled={probe.isFetching}>
              {probe.isFetching ? <Spinner /> : <RefreshCw />}
              Check now
            </Button>
          </CardAction>
        </CardHeader>
        <CardPanel className="text-sm">
          {probe.isError ? (
            <p className="text-destructive-foreground">{getUserErrorMessage(probe.error, 'The request failed.')}</p>
          ) : !probe.data ? (
            <p className="text-muted-foreground">Checking…</p>
          ) : probe.data.players.length === 0 ? (
            <p className="text-muted-foreground">No players online.</p>
          ) : (
            <ul className="grid gap-0.5 font-mono text-xs">
              {probe.data.players.slice(0, 8).map((player, index) => (
                <li key={index}>
                  {player.displayName || player.username || '?'} <span className="text-muted-foreground">at {player.x}, {player.y}</span>
                  {player.isAlive === false && <span className="text-destructive-foreground">, dead</span>}
                  {player.accessLevel && player.accessLevel.toLowerCase() !== 'none' && <span className="text-warning-foreground">, {player.accessLevel}</span>}
                </li>
              ))}
              {probe.data.players.length > 8 && <li className="text-muted-foreground">and {probe.data.players.length - 8} more</li>}
            </ul>
          )}
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Checks</CardTitle>
        </CardHeader>
        <CardPanel>
          {shown.length === 0 ? <p className="text-sm text-muted-foreground">Every check passed.</p> : <CheckList checks={shown} />}
        </CardPanel>
      </Card>
    </div>
  )
}
