import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface GameIntegrationStatusBadgeProps {
  connected: boolean
  running?: boolean
  loading?: boolean
  summary?: string | null
  className?: string
  /** Link to the server settings page, where the integration is installed. */
  interactive?: boolean
}

const STATES = {
  connected: { variant: 'success', label: 'Game integration connected', hint: undefined },
  waiting: { variant: 'warning', label: 'Game integration waiting', hint: 'Start or restart the game server to send live data.' },
  offline: { variant: 'error', label: 'Game integration offline', hint: 'Check Game integration in Server settings.' },
  loading: { variant: 'secondary', label: 'Checking…', hint: undefined },
} as const

export function GameIntegrationStatusBadge({ connected, running, loading, summary, className, interactive = true }: GameIntegrationStatusBadgeProps) {
  const state = STATES[loading ? 'loading' : connected ? 'connected' : running ? 'waiting' : 'offline']
  const tooltip = summary || state.hint
  return (
    <Badge
      variant={state.variant}
      size="lg"
      className={className}
      title={tooltip || undefined}
      aria-live="polite"
      aria-label={[state.label, tooltip].filter(Boolean).join('. ')}
      render={interactive ? <Link to="/server-settings" /> : undefined}
    >
      {loading ? <Loader2 className="animate-spin" /> : <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {state.label}
    </Badge>
  )
}
