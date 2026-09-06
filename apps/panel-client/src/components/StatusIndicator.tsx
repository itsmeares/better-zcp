import { cn } from '@/lib/utils'

type StatusState = 'online' | 'offline' | 'connecting' | 'unknown'

interface StatusIndicatorProps {
  state: StatusState
  label: string
  className?: string
}

const stateStyles: Record<StatusState, { dot: string; text: string }> = {
  online: {
    dot: 'bg-[hsl(var(--success))] shadow-[0_0_6px_hsl(var(--success)/0.5)]',
    text: 'text-foreground',
  },
  offline: {
    dot: 'bg-destructive',
    text: 'text-muted-foreground',
  },
  connecting: {
    dot: 'bg-warning animate-pulse',
    text: 'text-muted-foreground',
  },
  unknown: {
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
  },
}

export function StatusIndicator({ state, label, className }: StatusIndicatorProps) {
  const styles = stateStyles[state]
  return (
    <div role="status" aria-live="polite" className={cn('flex items-center gap-1.5', className)}>
      <div className={cn('h-2 w-2 rounded-full shrink-0', styles.dot)} aria-hidden="true" />
      <span className={cn('text-sm', styles.text)}>{label}</span>
    </div>
  )
}
