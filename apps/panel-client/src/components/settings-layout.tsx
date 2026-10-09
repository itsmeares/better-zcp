import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
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

/** The floating bar that appears while a page has unsaved edits. */
export function SaveBar({
  message,
  detail,
  saving,
  saveLabel = 'Save',
  saveDisabled,
  onSave,
  onDiscard,
}: {
  message: ReactNode
  detail?: ReactNode
  saving: boolean
  saveLabel?: string
  saveDisabled?: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  return (
    <div role="status" className="fixed inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div className="flex w-full max-w-lg items-center gap-3 rounded-xl border bg-popover py-2 ps-4 pe-2 shadow-lg">
        <span className="grid flex-1 text-sm">
          {message}
          {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
        </span>
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving || saveDisabled}>
          {saving && <Spinner />}
          {saveLabel}
        </Button>
      </div>
    </div>
  )
}
