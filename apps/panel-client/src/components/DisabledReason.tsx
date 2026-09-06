import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface DisabledReasonProps {
  /** Why the wrapped control is disabled, in operator language ("Start the server first"). Falsy renders children untouched -- no wrapper, no tooltip. */
  reason: string | null | undefined
  side?: 'top' | 'right' | 'bottom' | 'left'
  /**
   * Wrapper sizing. Default (inline-flex, shrink to content) fits a Button
   * sitting in a flex row next to other elements. Pass `"w-full"` for a
   * DropdownMenuItem -- Content lays items out in block flow with a real
   * width to fill, and an unsized wrapper there would shrink the disabled
   * row narrower than its enabled siblings.
   */
  className?: string
  children: React.ReactElement
}

// Wraps a control that may be `disabled` so hovering (or focusing) it while
// disabled explains why, instead of leaving the operator with a grey button
// and no next step.
//
// A disabled control fires no pointer or focus events, so a Tooltip attached
// directly to it never opens -- Radix's own trigger never sees the hover.
// The fix used throughout this app already (see the collapsed sidebar nav
// in Layout.tsx) is to make something else the trigger: here, a focusable
// span wrapped around the control. The span stays interactive even though
// the control inside it is inert; pass className="w-full" at call sites
// where the wrapper needs to fill a block-level row instead of shrinking
// to content (see the className prop doc above).
//
// Cost: for a plain disabled Button, this restores Tab-key reachability the
// browser would otherwise skip entirely -- previously nothing, so it's a net
// gain, at the cost of one tab stop that does nothing when activated. For a
// DropdownMenuItem specifically, Radix's own open-menu arrow-key navigation
// already skips disabled items regardless of this wrapper (unrelated,
// pre-existing menu behavior) -- so this fixes mouse hover there but does not
// add keyboard/screen-reader reach inside an open menu.
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
