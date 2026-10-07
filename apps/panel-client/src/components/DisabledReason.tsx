import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface DisabledReasonProps {
  reason: string | null | undefined
  side?: 'top' | 'right' | 'bottom' | 'left'
  className?: string
  children: React.ReactElement
}

/** Explains why a control is disabled. Browsers show no tooltip on a disabled element, so the wrapper takes the hover. */
export function DisabledReason({ reason, side = 'top', className, children }: DisabledReasonProps) {
  if (!reason) return children

  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className={cn('inline-flex cursor-not-allowed', className)} />}>{children}</TooltipTrigger>
      <TooltipPopup side={side} className="max-w-xs text-start leading-relaxed">
        {reason}
      </TooltipPopup>
    </Tooltip>
  )
}
