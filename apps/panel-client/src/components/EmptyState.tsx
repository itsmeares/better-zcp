import { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import {
  InboxIcon,
  SearchX,
  ServerOff,
  UsersRound,
  FileQuestion,
  WifiOff,
  CalendarX,
  Package,
  MessageSquareOff,
  FolderOpen,
  ShieldAlert
} from 'lucide-react'
import { Button } from '@/components/ui/button'

const emptyStateIcons = {
  noData: InboxIcon,
  noResults: SearchX,
  serverOffline: ServerOff,
  noPlayers: UsersRound,
  noFile: FileQuestion,
  disconnected: WifiOff,
  noSchedule: CalendarX,
  noMods: Package,
  noMessages: MessageSquareOff,
  empty: FolderOpen,
  accessDenied: ShieldAlert,
} as const

export type EmptyStateType = keyof typeof emptyStateIcons

type EmptyStateActionVariant = 'default' | 'outline' | 'secondary' | 'ghost'

export type EmptyStateAction =
  | { label: string; variant?: EmptyStateActionVariant; onClick: () => void; to?: undefined }
  | { label: string; variant?: EmptyStateActionVariant; to: string; onClick?: undefined }

interface EmptyStateProps {
  type?: EmptyStateType
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: EmptyStateAction
  secondaryAction?: EmptyStateAction
  compact?: boolean
  className?: string
}

function EmptyStateActionButton({ action, compact }: { action: EmptyStateAction; compact: boolean }) {
  const size = compact ? 'sm' : 'default'
  const variant = action.variant || 'outline'
  if (action.to !== undefined) {
    return (
      <Button asChild variant={variant} size={size} className="min-h-11">
        <Link to={action.to}>{action.label}</Link>
      </Button>
    )
  }
  return (
    <Button variant={variant} size={size} onClick={action.onClick} className="min-h-11">
      {action.label}
    </Button>
  )
}

export function EmptyState({
  type = 'noData',
  icon,
  title,
  description,
  action,
  secondaryAction,
  compact = false,
  className = ''
}: EmptyStateProps) {
  const { t } = useTranslation('emptyState')
  const IconComponent = emptyStateIcons[type]
  const eyebrow = t(`eyebrows.${type}`)
  const iconSize = compact ? 'w-10 h-10' : 'w-14 h-14'
  const containerSize = compact ? 'w-16 h-16' : 'w-20 h-20'
  const padding = compact ? 'py-8' : 'py-16'

  return (
    <div className={`flex flex-col items-center justify-center ${padding} px-4 text-center ${className}`} aria-live="polite" aria-atomic="true">
      <div className="relative mb-4">
        <div className={`${containerSize} empty-state-aura rounded-2xl border border-border/50 bg-muted/50 flex items-center justify-center empty-state-icon`} aria-hidden="true">
          {icon || <IconComponent className={`${iconSize} text-muted-foreground/40`} />}
        </div>
      </div>
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground/80">{eyebrow}</p>
      <h3 className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-foreground/80 mb-1`}>{title}</h3>
      {description && (
        <p className={`${compact ? 'text-xs' : 'text-sm'} max-w-sm leading-6 text-muted-foreground`}>{description}</p>
      )}
      {action && (
        <div className="mt-4 flex items-center gap-2">
          <EmptyStateActionButton action={action} compact={compact} />
          {secondaryAction && (
            <EmptyStateActionButton action={{ variant: 'ghost', ...secondaryAction }} compact={compact} />
          )}
        </div>
      )}
    </div>
  )
}
