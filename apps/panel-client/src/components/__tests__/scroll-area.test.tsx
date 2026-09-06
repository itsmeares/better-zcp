import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ScrollArea } from '../ui/scroll-area'

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
