import { Loader2 } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

type IntegrationState = 'connected' | 'waiting' | 'offline' | 'loading'

interface GameIntegrationStatusBadgeProps {
  connected: boolean
  running?: boolean
  loading?: boolean
  summary?: string | null
  className?: string
  interactive?: boolean
}

export function GameIntegrationStatusBadge({
  connected,
  running,
  loading,
  summary,
  className,
  interactive = true,
}: GameIntegrationStatusBadgeProps) {
  const state: IntegrationState = loading
    ? 'loading'
    : connected
      ? 'connected'
      : running
        ? 'waiting'
        : 'offline'

  const config: Record<
    IntegrationState,
    { surface: string; dot: string; label: string; hint?: string }
  > = {
    connected: {
      surface: 'border-primary/15 bg-primary/8',
      dot: 'bg-primary',
      label: 'Game integration connected',
    },
    waiting: {
      surface: 'border-warning/20 bg-warning/8',
      dot: 'bg-warning animate-pulse',
      label: 'Game integration waiting',
      hint: 'Start or restart the game server to send live data',
    },
    offline: {
      surface: 'border-destructive/20 bg-destructive/8',
      dot: 'bg-destructive',
      label: 'Game integration offline',
      hint: 'Check Game integration in Settings',
    },
    loading: {
      surface: 'border-border/40 bg-muted/30',
      dot: '',
      label: 'Checking…',
    },
  }

  const c = config[state]
  const tooltip = summary || c.hint
  const accessibleName = [c.label, tooltip].filter(Boolean).join('\n')

  const content = (
    <>
      {state === 'loading' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : (
        <div
          className={cn('h-2 w-2 shrink-0 rounded-full', c.dot)}
          aria-hidden="true"
        />
      )}
      <span className="text-sm font-medium text-foreground">{c.label}</span>
    </>
  )

  const classNames = cn(
    'flex items-center gap-2 rounded-lg border px-3 py-1.5',
    c.surface,
    interactive &&
      'cursor-pointer transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    className,
  )

  if (!interactive) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={accessibleName}
        title={tooltip || undefined}
        className={classNames}
      >
        {content}
      </div>
    )
  }

  return (
    <Link
      to="/settings"
      search={{ tab: 'game-integration' }}
      aria-live="polite"
      aria-label={accessibleName}
      title={tooltip || undefined}
      className={classNames}
    >
      {content}
    </Link>
  )
}
