import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import type { NavItem } from './nav'

export function NavTile({ item, className }: { item: NavItem; className?: string }) {
  const Icon = item.icon
  return (
    <span
      aria-hidden
      className={cn('nav-tile size-6', className)}
      style={{ '--hue': `var(--hue-${item.hue})` } as CSSProperties}
    >
      <Icon className="size-3.5" />
    </span>
  )
}
