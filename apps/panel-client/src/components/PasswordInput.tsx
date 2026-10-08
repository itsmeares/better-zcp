import { useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'

type PasswordInputProps = Omit<ComponentProps<typeof InputGroupInput>, 'value' | 'onChange' | 'type' | 'className'> & {
  className?: string
  value: string
  onChange: (value: string) => void
  /** Names the field for screen readers and the show/hide button. */
  label?: string
}

// InputGroup styles any aria-invalid attribute as an error, even "false".
export function PasswordInput({ value, onChange, className, label = 'password', id, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  return (
    <InputGroup className={className}>
      <InputGroupInput {...props} aria-invalid={props['aria-invalid'] || undefined} id={id} type={visible ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} aria-label={id ? undefined : label} />
      <InputGroupAddon align="inline-end">
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => setVisible((v) => !v)} aria-label={`${visible ? 'Hide' : 'Show'} ${label}`} aria-pressed={visible}>
          {visible ? <EyeOff /> : <Eye />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  )
}
