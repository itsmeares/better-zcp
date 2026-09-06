import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'

type BridgeState = 'connected' | 'waiting' | 'offline' | 'loading'

interface BridgeStatusBadgeProps {
  connected: boolean
  running?: boolean
  loading?: boolean
  bridgePath?: string | null
  summary?: string | null
  className?: string
  // Set to false only where the badge already lives inside the Settings ->
  // Bridge tab it would link to (a self-link there is dead weight, not a
  // destination). Every other call site gets a real link for free.
  interactive?: boolean
}

export function BridgeStatusBadge({ connected, running, loading, bridgePath, summary, className, interactive = true }: BridgeStatusBadgeProps) {
  const { t } = useTranslation('bridgeStatusBadge')
  const state: BridgeState = loading ? 'loading' : connected ? 'connected' : running ? 'waiting' : 'offline'

  const config: Record<BridgeState, { surface: string; dot: string; label: string; hint?: string }> = {
    connected: {
      surface: 'border-primary/15 bg-primary/8',
      dot: 'bg-primary',
      label: t('connected.label'),
    },
    waiting: {
      surface: 'border-warning/20 bg-warning/8',
      dot: 'bg-warning animate-pulse',
      label: t('waiting.label'),
      hint: t('waiting.hint'),
    },
    offline: {
      surface: 'border-destructive/20 bg-destructive/8',
      dot: 'bg-destructive',
      label: t('offline.label'),
      hint: t('offline.hint'),
    },
    loading: {
      surface: 'border-border/40 bg-muted/30',
      dot: '',
      label: t('loading.label'),
    },
  }

  const c = config[state]
  const tooltip = [
    summary || c.hint,
    bridgePath ? t('path', { path: bridgePath }) : null,
  ].filter(Boolean).join('\n')
  // role="status" does not derive an accessible name from its own visible
  // text (only interactive/content-naming roles do) -- without this, a
  // screen reader announces nothing at all when there's no hint/path (e.g.
  // connected/loading), and when there IS a title it becomes the entire
  // name via the last-resort title fallback, silently dropping the leading
  // state word. Building the name explicitly covers every state the same way.
  const accessibleName = [c.label, tooltip].filter(Boolean).join('\n')

  const content = (
    <>
      {state === 'loading' ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
      ) : (
        <div className={cn('w-2 h-2 rounded-full shrink-0', c.dot)} aria-hidden="true" />
      )}
      <span className="text-sm font-medium text-foreground">{c.label}</span>
    </>
  )

  if (!interactive) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={accessibleName}
        title={tooltip || undefined}
        className={cn('flex items-center gap-2 rounded-lg border px-3 py-1.5 cursor-default', c.surface, className)}
      >
        {content}
      </div>
    )
  }

  return (
    <Link
      to="/settings?tab=bridge"
      aria-live="polite"
      aria-label={accessibleName}
      title={tooltip || undefined}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-1.5 cursor-pointer transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        c.surface,
        className
      )}
    >
      {content}
    </Link>
  )
}
