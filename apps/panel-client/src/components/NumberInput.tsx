import { useEffect, useRef, useState } from 'react'
import type { FocusEvent, WheelEvent } from 'react'
import { Input } from '@/components/ui/input'

interface NumberInputProps {
  value: number
  onChange: (value: number) => void
  clamp?: (value: number) => number
  min?: number
  max?: number
  className?: string
  id?: string
  disabled?: boolean
  'aria-label'?: string
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void
  onWheel?: (e: WheelEvent<HTMLInputElement>) => void
}

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
