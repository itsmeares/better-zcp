import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { getCurrentLanguage, setLanguage, LANGUAGES } from '@/i18n'

export function LanguageSwitcher({ className }: { className?: string }) {
  const { t, i18n } = useTranslation('shell')
  const current = getCurrentLanguage()
  const currentLanguage = LANGUAGES.find((l) => l.code === current) ?? LANGUAGES[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className,
          )}
          aria-label={t('languageSwitcher.label')}
        >
          <Languages className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{currentLanguage.nativeName}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => {
              setLanguage(lang.code)
            }}
            className={cn(lang.code === current && 'font-medium text-foreground')}
          >
            {lang.nativeName}
            {lang.code === i18n.language ? ' ✓' : ''}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
