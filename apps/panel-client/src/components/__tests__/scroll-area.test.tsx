import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ScrollArea } from '../ui/scroll-area'

// This guards the fix itself from silently regressing, not a general detector
// for new misuse elsewhere -- jsdom does no real box layout, so it cannot
// measure whether content actually overflows, and asserting otherwise here
// would be a test that can't fail. See conv-hunt-pages (Scheduler, Debug,
// Players, Backups): Radix's ScrollArea Viewport wraps content in an internal
// `minWidth:100%; display:table` div, private markup we can't reach via
// props. Every real ScrollArea in this app is vertical-only (grepped: exactly
// one <ScrollBar>, defaulting to vertical, ever rendered), so Radix's own
// overflowX stays "hidden" regardless -- meaning that table sizing only ever
// lets content grow past the viewport with nowhere to scroll, silently
// clipping instead of wrapping/truncating as authored. This component clamps
// that wrapper to block layout by default; allowHorizontalOverflow opts back
// into Radix's native behavior for a genuine future wide-content case.
const CLAMP_CLASSNAME = '[&_[data-radix-scroll-area-viewport]>div]:!block'

describe('ScrollArea', () => {
  it('clamps the internal Viewport content wrapper to block layout by default', () => {
    const { container } = render(
      <ScrollArea>
        <div>content</div>
      </ScrollArea>,
    )
    expect((container.firstChild as HTMLElement).className).toContain(CLAMP_CLASSNAME)
  })

  it('allowHorizontalOverflow removes the clamp', () => {
    const { container } = render(
      <ScrollArea allowHorizontalOverflow>
        <div>content</div>
      </ScrollArea>,
    )
    expect((container.firstChild as HTMLElement).className).not.toContain(CLAMP_CLASSNAME)
  })
})
