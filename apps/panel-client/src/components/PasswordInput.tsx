import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface PasswordInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  /** Used in the toggle button's aria-label, e.g. "RCON password". Caller-supplied — translate at the call site. */
  label?: string
  maxLength?: number
  id?: string
  autoComplete?: string
}

// Defaults hidden (type="password") and toggles to type="text" on click —
// shared by every RCON/SFTP password field so the show/hide behavior and
// aria-labeling stay consistent instead of being re-implemented per form.
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
  const { t } = useTranslation('passwordInput')
  const [visible, setVisible] = useState(false)
  const resolvedLabel = label ?? t('defaultLabel')

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
        className="absolute end-1 top-1 h-9 w-9 p-0"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t('hide', { label: resolvedLabel }) : t('show', { label: resolvedLabel })}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  )
}
