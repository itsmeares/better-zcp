import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/utils"

// Radix's Viewport wraps children in an internal `minWidth:100%; display:table`
// div (not something we can pass a prop into -- it's private markup owned by
// Radix). That sizing exists so unwrapped content CAN grow past the viewport
// when a horizontal scrollbar is mounted to scroll to it. Nothing in this app
// mounts one: exactly one <ScrollBar> is ever rendered (below, vertical-only),
// so Radix's own overflowX stays "hidden" on every instance regardless -- the
// table sizing then just lets content grow past the viewport with nowhere to
// scroll, which silently clips instead of wrapping/truncating as authored.
// Every genuine horizontal-scroll need elsewhere in this app already uses a
// plain `overflow-x-auto` div, never ScrollArea, so this default matches
// existing practice rather than imposing a new one. Force block layout on that
// wrapper by default; allowHorizontalOverflow opts back into Radix's native
// behavior (skips the override AND mounts a real horizontal scrollbar) for a
// genuine future wide-content case -- never one without the other, since a
// clamp-free viewport with no scrollbar reproduces the original bug on purpose.
const SCROLL_AREA_CLAMP_CLASSNAME = "[&_[data-radix-scroll-area-viewport]>div]:!block"

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    allowHorizontalOverflow?: boolean
  }
>(({ className, children, allowHorizontalOverflow = false, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn(
      "relative overflow-hidden",
      !allowHorizontalOverflow && SCROLL_AREA_CLAMP_CLASSNAME,
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    {allowHorizontalOverflow && <ScrollBar orientation="horizontal" />}
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors",
      orientation === "vertical" &&
        "h-full w-2.5 border-s border-s-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
