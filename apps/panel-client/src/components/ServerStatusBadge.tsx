import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

type TFn = (key: string, opts?: Record<string, unknown>) => string

export interface StatusSignal {
  status: string
  label: string
  detail?: string | null
}

interface ServerStatusBadgeProps {
  host?: StatusSignal | null
  server?: StatusSignal | null
  bridge?: StatusSignal | null
  compact?: boolean
  className?: string
}

type IndicatorState = 'online' | 'offline' | 'connecting' | 'unknown'

const INDICATOR_STATE: Record<string, IndicatorState> = {
  running: 'online',
  connected: 'online',
  active: 'online',
  stopped: 'offline',
  disconnected: 'offline',
  offline: 'offline',
  connecting: 'connecting',
  unknown: 'unknown',
  'not-applicable': 'unknown',
  'not-installed': 'unknown',
}

function toIndicatorState(status: string): IndicatorState {
  return INDICATOR_STATE[status] ?? 'unknown'
}

const DOT_CLASS: Record<IndicatorState, string> = {
  online: 'bg-muted-foreground/50',
  offline: 'bg-destructive',
  connecting: 'bg-warning animate-pulse',
  unknown: 'bg-muted-foreground/50',
}

const TEXT_CLASS: Record<IndicatorState, string> = {
  online: 'text-foreground',
  offline: 'text-destructive',
  connecting: 'text-warning',
  unknown: 'text-muted-foreground',
}

const DISPLAY_WORD_KEYS: Record<string, string> = {
  running: 'displayWord.running',
  stopped: 'displayWord.stopped',
  connected: 'displayWord.connected',
  disconnected: 'displayWord.disconnected',
  connecting: 'displayWord.connecting',
  active: 'displayWord.active',
  offline: 'displayWord.offline',
  unknown: 'displayWord.unknown',
  'not-applicable': 'displayWord.not-applicable',
  'not-installed': 'displayWord.not-installed',
}

function displayWord(status: string, t: TFn): string {
  const key = DISPLAY_WORD_KEYS[status]
  return key ? t(key) : status
}

function shortWord(status: string, t: TFn): string {
  const state = toIndicatorState(status)
  if (state === 'online') return t('shortWord.up')
  if (state === 'offline') return t('shortWord.down')
  if (state === 'connecting') return t('shortWord.connecting')
  return status === 'not-installed' ? t('shortWord.notInstalled') : t('shortWord.unknown')
}

function CompactBadge({ signals, className, t }: { signals: StatusSignal[]; className?: string; t: TFn }) {
  const title = signals.map((s) => `${s.label}: ${displayWord(s.status, t)}`).join(' · ')
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)} title={title}>
      {signals.map((signal) => {
        const state = toIndicatorState(signal.status)
        return (
          <span key={signal.label} className={cn('inline-flex items-center gap-1 text-xs', TEXT_CLASS[state])}>
            <span className={cn('h-1.5 w-1.5 rounded-full', DOT_CLASS[state])} aria-hidden="true" />
            {signal.label} {shortWord(signal.status, t)}
          </span>
        )
      })}
    </div>
  )
}

export function ServerStatusBadge({ host, server, bridge, compact, className }: ServerStatusBadgeProps) {
  const { t } = useTranslation('serverStatusBadge')
  const signals = [host, server, bridge].filter((s): s is StatusSignal => Boolean(s))

  if (signals.length === 0) {
    return <span className={cn('text-xs text-muted-foreground', className)}>—</span>
  }

  if (compact) {
    return <CompactBadge signals={signals} className={className} t={t} />
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      {signals.map((signal) => {
        const state = toIndicatorState(signal.status)
        return (
          <span key={signal.label} role="status" className={cn('inline-flex items-center gap-1.5 text-xs', TEXT_CLASS[state])}>
            <span className={cn('h-1.5 w-1.5 rounded-full', DOT_CLASS[state])} aria-hidden="true" />
            {signal.label}: {displayWord(signal.status, t)}
          </span>
        )
      })}
    </div>
  )
}
