import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface HelpTipProps {
  /** The field/setting this explains, e.g. t('foo.label') — becomes the accessible name "Help: <label>". */
  label: string
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  className?: string
}

// Usage: place immediately after the label text it explains, in the same
// flex row — `<Label>...</Label><HelpTip label={...}>...</HelpTip>` — so the
// icon's position relative to its label stays identical on every screen.
//
// Radix's TooltipTrigger closes on its own click handler by default (it's
// built for hover, where a click is a dismiss gesture) — useless for touch,
// which has no hover to open it in the first place. preventDefault() on our
// click blocks that built-in close so the same click can open it instead;
// everything else (hover, keyboard focus/blur, Escape, outside tap, only
// one open at a time) is unmodified Radix behavior already wired for this
// by the ancestor TooltipProvider in App.tsx.
export function HelpTip({ label, children, side = 'top', className }: HelpTipProps) {
  const { t } = useTranslation('helpTip')
  const [open, setOpen] = useState(false)

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        type="button"
        onClick={(event) => {
          event.preventDefault()
          setOpen(true)
        }}
        aria-label={t('ariaLabel', { label })}
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          className,
        )}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs text-start text-xs leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}
