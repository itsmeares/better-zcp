import { ReactNode } from 'react'
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
  ShieldAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { cn } from '@/lib/utils'

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
  | {
      label: string
      variant?: EmptyStateActionVariant
      onClick: () => void
      to?: undefined
    }
  | {
      label: string
      variant?: EmptyStateActionVariant
      to: string
      onClick?: undefined
    }

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
      <Button variant={variant} size={size} render={<Link to={action.to} />}>
        {action.label}
      </Button>
    )
  }
  return (
    <Button variant={variant} size={size} onClick={action.onClick}>
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
  className,
}: EmptyStateProps) {
  const IconComponent = emptyStateIcons[type]
  return (
    <Empty className={cn(compact && 'gap-4 py-8 md:py-10', className)} aria-live="polite" aria-atomic="true">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon || <IconComponent />}</EmptyMedia>
        <EmptyTitle className={cn(compact && 'text-base')}>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && (
        <EmptyContent className="flex-row justify-center gap-2">
          <EmptyStateActionButton action={action} compact={compact} />
          {secondaryAction && <EmptyStateActionButton action={{ variant: 'ghost', ...secondaryAction }} compact={compact} />}
        </EmptyContent>
      )}
    </Empty>
  )
}
