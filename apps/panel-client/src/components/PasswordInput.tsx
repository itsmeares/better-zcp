import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui-legacy/input'
import { Button } from '@/components/ui-legacy/button'
import { cn } from '@/lib/utils'

interface PasswordInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  label?: string
  maxLength?: number
  id?: string
  autoComplete?: string
}

export function PasswordInput({
  value,
  onChange,
  placeholder,
  className,
  label,
  maxLength,
  id,
  autoComplete,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  const resolvedLabel = label ?? 'password'

  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        className={cn('pe-10', className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute inset-e-1 top-1 h-9 w-9 p-0"
        onClick={() => setVisible((v) => !v)}
        aria-label={
          visible
            ? 'Hide ' + String(resolvedLabel)
            : 'Show ' + String(resolvedLabel)
        }
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  )
}
