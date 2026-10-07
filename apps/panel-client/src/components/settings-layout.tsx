import type { ReactNode } from 'react'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** A titled group of settings rows. */
export function SettingsCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 border-b">
        <div className="grid gap-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardPanel className="grid gap-0 py-0">{children}</CardPanel>
    </Card>
  )
}

/** One setting: label and help on the left, the control on the right. */
export function SettingsRow({
  label,
  description,
  htmlFor,
  children,
  stacked = false,
}: {
  label: ReactNode
  description?: ReactNode
  htmlFor?: string
  children: ReactNode
  /** Put the control under the label, for wide inputs like text areas. */
  stacked?: boolean
}) {
  return (
    <div
      className={cn(
        'grid gap-3 border-b py-4 last:border-b-0',
        !stacked && 'sm:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)] sm:items-center sm:gap-6',
      )}
    >
      <div className="grid gap-0.5">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      <div className={cn('flex flex-wrap items-center gap-2', !stacked && 'sm:justify-end')}>{children}</div>
    </div>
  )
}
