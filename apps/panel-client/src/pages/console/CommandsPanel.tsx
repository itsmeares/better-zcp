import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, CornerDownLeft, History, Search, Trash2 } from 'lucide-react'
import { rconApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSocket } from '@/contexts/SocketContext'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { Card, CardPanel } from '@/components/ui/card'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import { toastManager } from '@/components/ui/toast'
import type { RconLink } from './useRconLink'

interface HistoryEntry {
  id: number
  command: string
  response: string
  success: number
  executed_at: string
}

interface LiveEntry {
  id: number
  command: string
  response: string
  success: boolean
  timestamp: string
}

const QUICK_COMMANDS = ['players', 'save', 'showoptions', 'checkModsNeedUpdate', 'help', 'serverinfo', 'getmemory']
const HISTORY_LIMIT = 50

/** Runs RCON commands. Output arrives over the `rcon-live` socket room, so other admins' commands show too. */
export function CommandsPanel({ link, active }: { link: RconLink; active: boolean }) {
  const socket = useSocket()
  const [command, setCommand] = useState('')
  const [draft, setDraft] = useState('')
  const [recallIndex, setRecallIndex] = useState(-1)
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<LiveEntry[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(0)
  const usable = link.configured && link.connected !== false
  const { markConnected } = link

  const loadHistory = useCallback(async () => {
    try {
      const data = (await rconApi.getHistory(HISTORY_LIMIT)) as { history?: HistoryEntry[] }
      setHistory(data.history ?? [])
    } catch {
      toastManager.add({ title: 'Command history unavailable', description: 'Recent commands could not be loaded.', type: 'error' })
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  useEffect(() => {
    if (!socket) return
    const onResponse = (data: Omit<LiveEntry, 'id'>) => {
      setOutput((prev) => [...prev, { ...data, id: ++nextId.current }].slice(-100))
      if (data.success) markConnected()
    }
    const subscribe = () => socket.emit('subscribe:rcon')
    socket.on('rcon:response', onResponse)
    if (socket.connected) subscribe()
    socket.on('connect', subscribe)
    return () => {
      socket.off('rcon:response', onResponse)
      socket.off('connect', subscribe)
    }
  }, [socket, markConnected])

  useEffect(() => {
    const view = outputRef.current
    if (view) requestAnimationFrame(() => (view.scrollTop = view.scrollHeight))
  }, [output])

  // Newest last, for arrow-key recall.
  const recall = history.map((entry) => entry.command).reverse()

  const run = async () => {
    const text = command.trim()
    if (!text) return
    setRunning(true)
    const result = await link.execute(text)
    if (!result.success) toastManager.add({ title: 'Command failed', description: result.error || 'The server rejected it.', type: 'error' })
    setCommand('')
    setRecallIndex(-1)
    setRunning(false)
    inputRef.current?.focus()
    void loadHistory()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') void run()
    if (event.key === 'ArrowUp' && recall.length > 0) {
      event.preventDefault()
      if (recallIndex === -1) setDraft(command)
      const next = Math.min(recallIndex + 1, recall.length - 1)
      setRecallIndex(next)
      setCommand(recall[recall.length - 1 - next] ?? '')
    }
    if (event.key === 'ArrowDown' && recallIndex >= 0) {
      event.preventDefault()
      const next = recallIndex - 1
      setRecallIndex(next)
      setCommand(next === -1 ? draft : (recall[recall.length - 1 - next] ?? ''))
    }
  }

  const fill = (text: string) => {
    setCommand(text)
    inputRef.current?.focus()
  }

  const query = search.toLowerCase()
  const matches = history.filter((entry) => !query || entry.command.toLowerCase().includes(query) || entry.response?.toLowerCase().includes(query))

  return (
    <div className="grid gap-3">
      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
          <span>Output{output.length > 0 ? `, ${output.length} entries` : ''}</span>
          <Button size="xs" variant="ghost" onClick={() => setOutput([])} disabled={output.length === 0}>
            <Trash2 />
            Clear view
          </Button>
        </div>
        <div ref={outputRef} role="log" aria-live="polite" aria-label="RCON command output" className="h-80 overflow-auto bg-muted/24 p-3 text-xs leading-5 lg:h-96">
          {output.length === 0 ? (
            <EmptyState compact type="noMessages" title="No commands yet" description="Run a command and the server's answer shows here." />
          ) : (
            output.map((entry) => (
              <div key={entry.id} className="mb-3 font-mono">
                <div className="flex gap-2">
                  <span className="text-muted-foreground">$</span>
                  <span className="min-w-0 flex-1 break-all font-medium">{entry.command}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{new Date(entry.timestamp).toLocaleTimeString('en')}</span>
                </div>
                <div className={cn('ms-4 border-s-2 ps-2 whitespace-pre-wrap wrap-break-word', entry.success ? 'border-border' : 'border-destructive/50 text-destructive-foreground')}>
                  {entry.response || ' '}
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      <div className="flex flex-wrap gap-1.5">
        {QUICK_COMMANDS.map((quick) => (
          <Button key={quick} size="xs" variant="outline" className="font-mono" onClick={() => fill(quick)} disabled={!usable}>
            {quick}
          </Button>
        ))}
      </div>

      <div className="flex gap-2">
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText className="font-mono">$</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command"
            className="font-mono"
            maxLength={2000}
            disabled={running || !usable}
            aria-label="RCON command"
          />
        </InputGroup>
        <Button onClick={() => void run()} disabled={running || !command.trim() || !usable}>
          {running ? <Spinner /> : <CornerDownLeft />}
          Run
        </Button>
      </div>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Kbd>Enter</Kbd> runs it right away, with no confirm. <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> recall earlier commands.
      </p>

      <Collapsible>
        <Card className="p-0">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-sm font-medium">
            <History className="size-4 text-muted-foreground" />
            History
            <span className="font-normal text-muted-foreground">
              {history.length > 0 && `${history.length} recent${history.length >= HISTORY_LIMIT ? ', older ones not shown' : ''}`}
            </span>
            <ChevronDown className="ms-auto size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <CardPanel className="grid gap-2 border-t pt-3 pb-3">
              <InputGroup>
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search commands and answers" aria-label="Search command history" />
              </InputGroup>
              <div className="max-h-80 overflow-auto">
                {matches.length === 0 ? (
                  <p className="p-2 text-sm text-muted-foreground">{history.length === 0 ? 'Commands you run are kept here.' : 'Nothing matches.'}</p>
                ) : (
                  matches.map((entry) => (
                    <button key={entry.id} type="button" onClick={() => fill(entry.command)} className="grid w-full gap-0.5 rounded-md px-2 py-1.5 text-start hover:bg-accent">
                      <span className="flex gap-2">
                        <code className="min-w-0 flex-1 truncate text-sm">{entry.command}</code>
                        <span className="shrink-0 text-xs text-muted-foreground">{new Date(entry.executed_at).toLocaleString('en')}</span>
                      </span>
                      {entry.response && (
                        <span className={cn('truncate font-mono text-xs', entry.success ? 'text-muted-foreground' : 'text-destructive-foreground')}>{entry.response}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </CardPanel>
          </CollapsiblePanel>
        </Card>
      </Collapsible>
    </div>
  )
}
