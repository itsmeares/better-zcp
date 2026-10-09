import { useState } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { Copy, Download, RefreshCw } from 'lucide-react'
import { debugApi, downloadFile } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn, copyText, formatBytes } from '@/lib/utils'
import { EmptyState } from '@/components/EmptyState'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { toastManager } from '@/components/ui/toast'

export const crashesQuery = queryOptions({ queryKey: ['diagnostics', 'crashes'], queryFn: debugApi.getCrashLogs, retry: false })

const DAY_MS = 24 * 60 * 60 * 1000

export function CrashesPanel() {
  const list = useQuery(crashesQuery)
  const [selected, setSelected] = useState<string | null>(null)
  const content = useQuery({
    queryKey: ['diagnostics', 'crash', selected],
    queryFn: () => debugApi.getCrashLog(selected!),
    enabled: selected !== null,
    retry: false,
  })
  const crashes = [...(list.data?.crashLogs ?? [])].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
  const total = list.data?.totalCount ?? crashes.length
  const text = content.data ? content.data.content || '(empty file)' : ''

  const copy = async () => {
    const ok = await copyText(text)
    toastManager.add(ok ? { title: 'Crash log copied', type: 'success' } : { title: "Couldn't copy", description: 'The browser blocked clipboard access.', type: 'error' })
  }
  const download = async (name: string) => {
    try {
      await downloadFile(`/debug/crash-logs/${encodeURIComponent(name)}/download`, name)
    } catch (error) {
      toastManager.add({ title: "Couldn't download the crash log", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    }
  }

  if (!list.isPending && crashes.length === 0) {
    return list.isError ? (
      <EmptyState type="noFile" title="Couldn't list crash logs" description={getUserErrorMessage(list.error, 'Try again.')} action={{ label: 'Retry', onClick: () => void list.refetch() }} />
    ) : (
      <EmptyState type="noData" title="No crash logs" description="The game hasn't left any Java crash dumps or error logs." action={{ label: 'Check again', variant: 'outline', onClick: () => void list.refetch() }} />
    )
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[20rem_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Crash logs</CardTitle>
          <CardDescription>{total > crashes.length ? `The newest ${crashes.length} of ${total}.` : 'Java crash dumps and error logs.'}</CardDescription>
          <CardAction>
            <Button size="icon-sm" variant="ghost" onClick={() => void list.refetch()} aria-label="Check for new crash logs">
              {list.isFetching ? <Spinner /> : <RefreshCw />}
            </Button>
          </CardAction>
        </CardHeader>
        <CardPanel className="px-2">
          <ul className="grid max-h-[calc(100dvh-22rem)] content-start gap-0.5 overflow-auto">
            {crashes.map((crash) => (
              <li key={crash.name}>
                <button
                  type="button"
                  onClick={() => setSelected(crash.name)}
                  aria-current={selected === crash.name}
                  className={cn('grid w-full gap-0.5 rounded-md px-3 py-2 text-start text-sm hover:bg-accent', selected === crash.name && 'bg-accent')}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{crash.name}</span>
                    {Date.now() - Date.parse(crash.modified) < DAY_MS && <Badge variant="error">New</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(crash.size)}, {new Date(crash.modified).toLocaleString('en')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CardPanel>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="truncate font-mono text-sm">{selected ?? 'No file open'}</CardTitle>
          {content.data?.truncated && <CardDescription>Showing the first 100 KB. Download the file to see the rest.</CardDescription>}
          {selected && content.data && (
            <CardAction className="gap-1">
              <Button size="icon-sm" variant="ghost" onClick={() => void copy()} aria-label="Copy what is shown">
                <Copy />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => void download(selected)} aria-label="Download the full file">
                <Download />
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardPanel>
          {!selected ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Pick a crash log to read it.</p>
          ) : content.isPending ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : content.isError ? (
            <p className="text-sm text-destructive-foreground">{getUserErrorMessage(content.error, "Couldn't read this crash log.")}</p>
          ) : (
            <pre className="h-[calc(100dvh-22rem)] min-h-72 overflow-auto rounded-md bg-muted/24 p-3 font-mono text-xs break-all whitespace-pre-wrap">{text}</pre>
          )}
        </CardPanel>
      </Card>
    </div>
  )
}
