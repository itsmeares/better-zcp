import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowDownToLine, EyeOff, MoreHorizontal, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { serverApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/contexts/ConfirmContext'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'
import { EmptyState } from '@/components/EmptyState'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Spinner } from '@/components/ui/spinner'
import { toastManager } from '@/components/ui/toast'
import { Toggle } from '@/components/ui/toggle'
import { isNoise, parseLogLine, type ParsedLogLine } from './logLine'

const LEVEL_TEXT: Record<ParsedLogLine['type'], string> = {
  ERROR: 'text-destructive-foreground',
  WARN: 'text-warning-foreground',
  INFO: 'text-info-foreground',
  LOG: 'text-foreground',
  DEBUG: 'text-muted-foreground',
  UNKNOWN: 'text-muted-foreground',
}

const LogLine = memo(function LogLine({ line }: { line: string }) {
  const parsed = parseLogLine(line)
  if (!parsed.message) return null
  return (
    <div
      className={cn(
        'flex gap-2 rounded-sm px-2 py-px',
        parsed.type === 'ERROR' && 'bg-destructive/8',
        parsed.type === 'WARN' && 'bg-warning/8',
      )}
    >
      <span className="w-15 shrink-0 text-muted-foreground tabular-nums">{parsed.time ?? ''}</span>
      <span className={cn('w-11 shrink-0 font-medium', LEVEL_TEXT[parsed.type])}>{parsed.type === 'UNKNOWN' ? '' : parsed.type}</span>
      <span className="min-w-0 wrap-break-word">
        {parsed.category && <span className="text-muted-foreground">[{parsed.category}] </span>}
        <span className={parsed.type === 'ERROR' || parsed.type === 'WARN' ? LEVEL_TEXT[parsed.type] : undefined}>{parsed.message}</span>
      </span>
    </div>
  )
})

const KEEP_LINES = 500

/** Follows server-console.txt by polling for new bytes every 2 seconds. */
export function ServerLogPanel({ hasLogSource }: { hasLogSource: boolean }) {
  const confirm = useConfirm()
  const [lines, setLines] = useState<string[]>([])
  const [path, setPath] = useState('')
  const [exists, setExists] = useState(true)
  const [loading, setLoading] = useState(true)
  const [streamDown, setStreamDown] = useState(false)
  const [paused, setPaused] = useState(false)
  const [hideNoise, setHideNoise] = useState(true)
  const [follow, setFollow] = useState(true)
  const sizeRef = useRef(0)
  const failuresRef = useRef(0)
  const pausedRef = useRef(paused)
  const viewRef = useRef<HTMLDivElement>(null)
  pausedRef.current = paused

  usePageShortcut('a', () => setFollow((value) => !value))

  const load = useCallback(async () => {
    setLoading(true)
    setStreamDown(false)
    failuresRef.current = 0
    try {
      const data = await serverApi.getConsoleLog(1000)
      setLines((data.lines || []).slice(-KEEP_LINES))
      sizeRef.current = data.size || 0
      setPath(data.path || '')
      setExists(Boolean(data.exists))
    } catch {
      setStreamDown(true)
    } finally {
      setLoading(false)
    }
  }, [])

  const poll = useCallback(async () => {
    try {
      const data = await serverApi.streamConsoleLog(sizeRef.current)
      if (data.rotated) setLines(data.newLines || [])
      else if (data.newLines?.length) setLines((prev) => [...prev, ...data.newLines].slice(-KEEP_LINES))
      sizeRef.current = data.currentSize || sizeRef.current
      failuresRef.current = 0
      setStreamDown(false)
    } catch {
      // One missed poll is normal while the server restarts; three in a row is worth saying.
      if (++failuresRef.current >= 3) setStreamDown(true)
    }
  }, [])

  useEffect(() => {
    if (!hasLogSource) return
    void load()
    const timer = setInterval(() => {
      if (!pausedRef.current && document.visibilityState !== 'hidden') void poll()
    }, 2000)
    return () => clearInterval(timer)
  }, [hasLogSource, load, poll])

  const shown = useMemo(() => (hideNoise ? lines.filter((line) => !isNoise(line)) : lines), [lines, hideNoise])
  const hidden = lines.length - shown.length

  useEffect(() => {
    const view = viewRef.current
    if (follow && view) requestAnimationFrame(() => (view.scrollTop = view.scrollHeight))
  }, [shown, follow])

  const eraseLog = async () => {
    const confirmed = await confirm({
      title: 'Erase the server console log?',
      description: 'This erases server-console.txt on disk, not just this view. There is no undo.',
      confirmLabel: 'Erase log file',
      destructive: true,
    })
    if (!confirmed) return
    try {
      await serverApi.clearConsoleLog()
      setLines([])
      sizeRef.current = 0
      toastManager.add({ title: 'Console log erased', type: 'success' })
    } catch (error) {
      toastManager.add({ title: 'Could not erase the log', description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    }
  }

  if (!hasLogSource) {
    return (
      <EmptyState
        type="noFile"
        title="The panel doesn't know where the log is"
        description="Set the install folder or the Zomboid data folder for this server first."
        action={{ label: 'Server settings', to: '/server-settings' }}
      />
    )
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={path || undefined}>
          {path || 'Loading…'}
        </p>
        <Toggle size="sm" variant="outline" pressed={paused} onPressedChange={setPaused} aria-label={paused ? 'Resume updates' : 'Pause updates'}>
          {paused ? <Play /> : <Pause />}
          {paused ? 'Resume' : 'Pause'}
        </Toggle>
        <Toggle size="sm" variant="outline" pressed={hideNoise} onPressedChange={setHideNoise} title="Hide lines the game repeats constantly">
          <EyeOff />
          Hide noise{hideNoise && hidden > 0 ? ` (${hidden})` : ''}
        </Toggle>
        <Toggle size="sm" variant="outline" pressed={follow} onPressedChange={setFollow} title="Keep the newest line in view (A)">
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
            <MenuItem variant="destructive" onClick={() => void eraseLog()}>
              <Trash2 />
              Erase log file…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      {streamDown && (
        <Alert variant="error">
          <AlertDescription>The log stopped updating. The server may be offline.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {!exists && !loading ? (
        <EmptyState
          type="serverOffline"
          title="No console log yet"
          description={
            <>
              The server writes server-console.txt when it starts. Start it from <Link to="/">Overview</Link>.
            </>
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div
            ref={viewRef}
            role="log"
            aria-live="polite"
            aria-label="Server console output"
            className="h-[calc(100dvh-20rem)] min-h-72 overflow-auto bg-muted/24 p-2 font-mono text-xs leading-5"
          >
            {shown.length === 0 ? (
              <p className="p-2 text-muted-foreground">
                {hidden > 0 ? (
                  <>
                    All {hidden} lines are noise.{' '}
                    <button type="button" className="underline underline-offset-4" onClick={() => setHideNoise(false)}>
                      Show them
                    </button>
                  </>
                ) : (
                  'Nothing written since this view opened.'
                )}
              </p>
            ) : (
              shown.map((line, index) => <LogLine key={index} line={line} />)
            )}
          </div>
          <div className="flex justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {shown.length} lines{hidden > 0 ? `, ${hidden} hidden` : ''}
            </span>
            <span>{paused ? 'Paused' : 'Updates every 2s'}</span>
          </div>
        </Card>
      )}
    </div>
  )
}
