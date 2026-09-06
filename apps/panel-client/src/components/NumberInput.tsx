import { useEffect, useRef, useState } from 'react'
import type { FocusEvent, WheelEvent } from 'react'
import { Input } from '@/components/ui/input'

interface NumberInputProps {
  value: number
  onChange: (value: number) => void
  /** Applied only to a value the user actually typed, e.g. Math.max(1, n) for a memory field. Never applied to an empty/unparseable field. */
  clamp?: (value: number) => number
  min?: number
  max?: number
  className?: string
  id?: string
  disabled?: boolean
  'aria-label'?: string
  /**
   * For a site with no submit-time refusal path to fall through to (e.g. a
   * bounded count, not a port) -- runs AFTER this component's own blur
   * bookkeeping, so the caller can commit an empty/out-of-range field to a
   * sane value itself. Receives the real DOM blur event; e.target.value is
   * whatever the operator actually left in the field.
   */
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void
  /** Passed straight through -- e.g. blurring on wheel so an accidental scroll over the field can't change its value. */
  onWheel?: (e: WheelEvent<HTMLInputElement>) => void
}

// Every plain numeric <Input> in this app used to run
// `onChange={(e) => setX(parseInt(e.target.value) || DEFAULT)}` -- the
// instant the field went empty (or briefly unparseable mid-edit), it
// silently snapped back to a hardcoded default under the operator's own
// cursor. This component instead shows exactly what was typed, including
// empty, and only ever calls onChange with a value the operator actually
// entered; an empty or unparseable field reports NaN upward so the
// caller's OWN existing submit-time validation (isValidInstallPort(),
// isValidPort(), a disabled-button guard, ...) refuses it the same way it
// already refuses an out-of-range number -- this component does not
// invent a second validation path.
//
// `text` is the field's own source of truth while focused, so a full
// resync from `value` while the operator is mid-edit can never overwrite
// what they're typing. Once they leave the field (or something external
// changes `value` -- RAM auto-detect, a loaded setting, a slider bound to
// the same state), the effect below catches up `text` to match.
export function NumberInput({ value, onChange, clamp, min, max, className, id, disabled, onBlur, onWheel, 'aria-label': ariaLabel }: NumberInputProps) {
  const [text, setText] = useState(() => (Number.isFinite(value) ? String(value) : ''))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setText(Number.isFinite(value) ? String(value) : '')
  }, [value])

  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      className={className}
      disabled={disabled}
      aria-label={ariaLabel}
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={(e) => {
        focused.current = false
        onBlur?.(e)
      }}
      onWheel={onWheel}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        const parsed = raw.trim() === '' ? NaN : parseInt(raw, 10)
        onChange(Number.isNaN(parsed) ? NaN : clamp ? clamp(parsed) : parsed)
      }}
    />
  )
}
