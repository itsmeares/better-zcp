import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'

interface PasswordInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  /** Names the field for screen readers and the show/hide button. */
  label?: string
  maxLength?: number
  id?: string
  autoComplete?: string
}

export function PasswordInput({ value, onChange, placeholder, className, label = 'password', maxLength, id, autoComplete }: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  return (
    <InputGroup className={className}>
      <InputGroupInput
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        aria-label={id ? undefined : label}
      />
      <InputGroupAddon align="inline-end">
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => setVisible((v) => !v)} aria-label={`${visible ? 'Hide' : 'Show'} ${label}`}>
          {visible ? <EyeOff /> : <Eye />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  )
}
