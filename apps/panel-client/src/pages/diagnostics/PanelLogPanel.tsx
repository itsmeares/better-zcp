import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, Copy, Download, MoreHorizontal, Pause, Play, RefreshCw, Search, Trash2 } from 'lucide-react'
import { debugApi, downloadFile, saveBlob, type PanelLogEntry } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn, copyText, formatBytes } from '@/lib/utils'
import { SocketContext } from '@/contexts/SocketContext'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { toastManager } from '@/components/ui/toast'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

type Level = PanelLogEntry['level']
type Line = PanelLogEntry & { id: number }

const KEEP_LINES = 500
const LONG = 200
const LEVELS: Array<{ value: Level; label: string }> = [
  { value: 'error', label: 'Errors' },
  { value: 'warn', label: 'Warnings' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
]
const LEVEL_TEXT: Record<Level, string> = {
  error: 'text-destructive-foreground',
  warn: 'text-warning-foreground',
  info: 'text-foreground',
  debug: 'text-muted-foreground',
}

let nextId = 0
const toLine = (entry: PanelLogEntry): Line => ({ ...entry, id: nextId++ })
const lineText = (line: PanelLogEntry) => `[${new Date(line.timestamp).toISOString()}] [${line.level.toUpperCase()}]${line.source ? ` [${line.source}]` : ''} ${line.message}`
const today = () => new Date().toISOString().split('T')[0]

async function download(endpoint: string, filename: string) {
  try {
    await downloadFile(endpoint, filename)
  } catch (error) {
    toastManager.add({ title: `Couldn't download ${filename}`, description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
  }
}

/** The panel's own log: what the panel did and what went wrong inside it. */
export function PanelLogPanel() {
  const socket = useContext(SocketContext)
  const [lines, setLines] = useState<Line[]>([])
  const [loading, setLoading] = useState(true)
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [level, setLevel] = useState<Level | 'all'>('all')
  const [source, setSource] = useState('all')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const viewRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const files = useQuery({ queryKey: ['diagnostics', 'log-files'], queryFn: debugApi.getLogFiles, retry: false })

  usePageShortcut(' ', () => setPaused((value) => !value))
  usePageShortcut('f', () => searchRef.current?.focus(), { ctrl: true })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setLines((await debugApi.getLogs()).logs.map(toLine))
    } catch (error) {
      toastManager.add({ title: "Couldn't load the panel log", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void load(), [load])

  // App subscribes this socket to the log room when it connects.
  useEffect(() => {
    if (!socket || paused) return
    const onLog = (entry: PanelLogEntry) => setLines((current) => [...current.slice(-(KEEP_LINES - 1)), toLine(entry)])
    socket.on('log:entry', onLog)
    socket.on('panel:log', onLog)
    return () => {
      socket.off('log:entry', onLog)
      socket.off('panel:log', onLog)
    }
  }, [socket, paused])

  const counts = useMemo(() => {
    const result: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0 }
    for (const line of lines) result[line.level] = (result[line.level] ?? 0) + 1
    return result
  }, [lines])
  const sources = useMemo(() => [...new Set(lines.flatMap((line) => (line.source ? [line.source] : [])))].sort(), [lines])
  const sourceItems = [{ value: 'all', label: 'All sources' }, ...sources.map((value) => ({ value, label: value }))]

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return lines.filter(
      (line) =>
        (level === 'all' || line.level === level) &&
        (source === 'all' || line.source === source) &&
        (!needle || line.message.toLowerCase().includes(needle) || line.source?.toLowerCase().includes(needle)),
    )
  }, [lines, level, source, search])

  useEffect(() => {
    const view = viewRef.current
    if (follow && view) requestAnimationFrame(() => (view.scrollTop = view.scrollHeight))
  }, [shown, follow])

  const exportShown = (format: 'txt' | 'json') => {
    const content =
      format === 'json'
        ? JSON.stringify(shown.map(({ timestamp, level, source, message }) => ({ timestamp, level, source: source || 'server', message })), null, 2)
        : shown.map(lineText).join('\n')
    saveBlob(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/plain' }), `pz-logs-filtered-${today()}.${format}`)
  }

  const copyLine = async (line: Line) => {
    const ok = await copyText(lineText(line))
    toastManager.add(ok ? { title: 'Line copied', type: 'success' } : { title: "Couldn't copy", description: 'The browser blocked clipboard access.', type: 'error' })
  }

  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-full sm:w-64">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput ref={searchRef} type="search" placeholder="Search the log" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={128} aria-label="Search the panel log" />
          </InputGroup>
          <ToggleGroup size="sm" variant="outline" value={[level]} onValueChange={(value) => setLevel((value[0] as Level) ?? 'all')} aria-label="Level">
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            {LEVELS.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value}>
                {item.label}
                {counts[item.value] > 0 && <span className="text-muted-foreground tabular-nums">{counts[item.value]}</span>}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {sources.length > 0 && (
            <Select items={sourceItems} value={source} onValueChange={(value) => setSource(String(value ?? 'all'))}>
              <SelectTrigger className="w-40" aria-label="Source">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {sourceItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <span className="flex-1" />
          <Toggle size="sm" variant="outline" pressed={paused} onPressedChange={setPaused} title="Pause or resume (Space)">
            {paused ? <Play /> : <Pause />}
            {paused ? 'Resume' : 'Pause'}
          </Toggle>
          <Toggle size="sm" variant="outline" pressed={follow} onPressedChange={setFollow} title="Keep the newest line in view">
            <ArrowDownToLine />
            Follow
          </Toggle>
          <Button size="icon-sm" variant="ghost" onClick={() => void load()} aria-label="Reload the log">
            {loading ? <Spinner /> : <RefreshCw />}
          </Button>
          <Menu>
            <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More log actions" />}>
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => void download('/debug/logs/download', `pz-manager-logs-${today()}.txt`)}>
                <Download />
                Download the full log
              </MenuItem>
              <MenuItem onClick={() => exportShown('txt')}>
                <Download />
                Export what is shown (.txt)
              </MenuItem>
              <MenuItem onClick={() => exportShown('json')}>
                <Download />
                Export what is shown (.json)
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => setLines([])}>
                <Trash2 />
                Clear this view
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>

        <Card className="overflow-hidden p-0">
          <div ref={viewRef} role="log" aria-label="Panel log" className="h-[calc(100dvh-22rem)] min-h-72 overflow-auto bg-muted/24 p-2 font-mono text-xs leading-5">
            {shown.length === 0 ? (
              <p className="p-2 font-sans text-sm text-muted-foreground">{lines.length === 0 ? (loading ? 'Loading…' : 'Nothing logged yet.') : 'No lines match the filters.'}</p>
            ) : (
              shown.map((line) => {
                const long = line.message.length > LONG
                const expanded = open.has(line.id)
                return (
                  <div key={line.id} className={cn('group flex items-start gap-2 rounded-sm px-2 py-px hover:bg-accent/60', line.level === 'error' && 'bg-destructive/8', line.level === 'warn' && 'bg-warning/8')}>
                    <span className="w-17 shrink-0 text-muted-foreground tabular-nums" title={new Date(line.timestamp).toLocaleString('en')}>
                      {new Date(line.timestamp).toLocaleTimeString('en', { hour12: false })}
                    </span>
                    <span className={cn('w-11 shrink-0 font-medium uppercase', LEVEL_TEXT[line.level])}>{line.level}</span>
                    {line.source && <span className="shrink-0 text-muted-foreground">[{line.source}]</span>}
                    <span className={cn('min-w-0 flex-1 wrap-break-word', (line.level === 'error' || line.level === 'warn') && LEVEL_TEXT[line.level])}>
                      {long && !expanded ? `${line.message.slice(0, LONG)}…` : line.message}
                      {long && (
                        <button type="button" onClick={() => toggle(line.id)} className="ms-2 font-sans text-muted-foreground underline underline-offset-2 hover:text-foreground">
                          {expanded ? 'Less' : 'More'}
                        </button>
                      )}
                    </span>
                    <button type="button" onClick={() => void copyLine(line)} aria-label="Copy line" className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100">
                      <Copy className="size-3.5" />
                    </button>
                  </div>
                )
              })
            )}
          </div>
          <div className="flex justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
            <span className="tabular-nums">{shown.length === lines.length ? `${lines.length} lines` : `${shown.length} of ${lines.length} lines`}</span>
            <span>{paused ? 'Paused' : 'Live'}</span>
          </div>
        </Card>
      </div>

      {(files.data?.files.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Log files</CardTitle>
            <CardDescription>The panel's log files on disk. The support bundle has all of them plus the game's logs.</CardDescription>
          </CardHeader>
          <CardPanel>
            <ul className="divide-y text-sm">
              {files.data!.files.map((file) => (
                <li key={file.name} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.name}</span>
                  <span className="text-muted-foreground tabular-nums">{formatBytes(file.size)}</span>
                  <span className="hidden text-muted-foreground sm:inline">{new Date(file.modified).toLocaleString('en')}</span>
                  <Button size="icon-sm" variant="ghost" onClick={() => void download(`/debug/logs/download/${encodeURIComponent(file.name)}`, file.name)} aria-label={`Download ${file.name}`}>
                    <Download />
                  </Button>
                </li>
              ))}
            </ul>
          </CardPanel>
        </Card>
      )}
    </div>
  )
}
