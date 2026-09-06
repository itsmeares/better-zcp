import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface DisabledReasonProps {
  reason: string | null | undefined
  side?: 'top' | 'right' | 'bottom' | 'left'
  className?: string
  children: React.ReactElement
}

export function DisabledReason({ reason, side = 'top', className, children }: DisabledReasonProps) {
  if (!reason) return children

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn('inline-flex cursor-not-allowed', className)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs text-start text-xs leading-relaxed">
        {reason}
      </TooltipContent>
    </Tooltip>
  )
}
