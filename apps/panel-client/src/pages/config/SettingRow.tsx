import { memo } from 'react'
import { TriangleAlert, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatRawConfigValue, normalizeNumericInput } from '@/lib/serverConfigSchema'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export interface RowField {
  /** Passed to the callbacks. Defaults to the key; Sandbox uses section.key because keys repeat across sections. */
  id?: string
  key: string
  label: string
  description: string
  type: 'boolean' | 'number' | 'string' | 'select' | 'multiline'
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  default?: unknown
}

/**
 * One setting: label, description, key and default, and the right control for its type.
 * Values arrive as a string or a boolean; the caller converts to what its file stores.
 */
export const SettingRow = memo(function SettingRow({
  field,
  value,
  unsaved,
  differsFromDefault,
  invalid,
  unrecognized,
  onChange,
  onReset,
}: {
  field: RowField
  value: string | boolean
  unsaved: boolean
  differsFromDefault: boolean
  invalid?: boolean
  unrecognized?: string
  onChange: (key: string, value: string | boolean) => void
  onReset: (key: string) => void
}) {
  const id = field.id ?? field.key
  const range =
    field.min !== undefined && field.max !== undefined ? `${field.min} to ${field.max}` : field.min !== undefined ? `At least ${field.min}` : field.max !== undefined ? `At most ${field.max}` : null
  const options = unrecognized && typeof value === 'string' ? [{ value, label: `${value} (unknown)` }, ...(field.options ?? [])] : (field.options ?? [])

  const control =
    field.type === 'boolean' ? (
      <Switch checked={value === true} onCheckedChange={(checked) => onChange(id, checked)} aria-label={field.label} />
    ) : field.type === 'select' ? (
      <Select items={options} value={String(value)} onValueChange={(next) => onChange(id, String(next))}>
        <SelectTrigger className={cn('w-full sm:w-52', unrecognized && 'border-warning')} aria-label={field.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={!!unrecognized && option.value === value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : field.type === 'multiline' ? null : (
      <Input
        value={String(value)}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        onChange={(event) => onChange(id, field.type === 'number' ? normalizeNumericInput(event.target.value) : event.target.value)}
        aria-invalid={invalid || undefined}
        aria-label={field.label}
        maxLength={512}
        className={cn('w-full sm:w-52', field.type === 'number' && 'text-end')}
      />
    )

  return (
    <div className={cn('grid gap-2 border-b px-3 py-3 last:border-b-0', unsaved && 'bg-warning/6')} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 88px' }}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            {field.label}
            {unsaved && <Badge variant="warning">Unsaved</Badge>}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{field.description}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <code className="font-mono">{field.key}</code>
            {field.default !== undefined && <span className={cn(differsFromDefault && 'text-warning-foreground')}>Default {formatRawConfigValue(field.default) || '(empty)'}</span>}
            {range && <span>{range}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {unsaved && (
            <Button size="icon-sm" variant="ghost" onClick={() => onReset(id)} aria-label={`Undo the change to ${field.label}`} title="Undo this change">
              <Undo2 />
            </Button>
          )}
          {control}
        </div>
      </div>
      {field.type === 'multiline' && (
        <Textarea value={String(value)} onChange={(event) => onChange(id, event.target.value)} className="min-h-20 font-mono text-sm" aria-label={field.label} />
      )}
      {invalid && <p className="text-sm text-destructive-foreground">Enter a number{range ? ` from ${range.toLowerCase()}` : ''}.</p>}
      {unrecognized && (
        <p className="flex items-start gap-1.5 text-sm text-warning-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {unrecognized}
        </p>
      )}
    </div>
  )
})
