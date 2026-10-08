import { HelpCircle } from 'lucide-react'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface HelpTipProps {
  label: string
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  className?: string
}

/** A small help icon. It opens on hover and on tap, so it works on phones too. */
export function HelpTip({ label, children, side = 'top', className }: HelpTipProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        aria-label={`Help: ${label}`}
        className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', className)}
      >
        <HelpCircle className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side={side} className="max-w-xs text-xs leading-relaxed">
        {children}
      </PopoverPopup>
    </Popover>
  )
}
