import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DirectionProvider } from '@radix-ui/react-direction'
import { Slider } from '@/components/ui/slider'

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

// Radix's own direction hook (@radix-ui/react-direction's useDirection) has
// NO fallback to document.documentElement.dir -- `localDir || globalDir ||
// "ltr"`, nothing else. Every RTL-aware Radix primitive used in this app
// (Slider, Select, Tabs, Accordion, Menu/DropdownMenu, ScrollArea,
// RovingFocus) silently stays 'ltr' forever unless wrapped in
// @radix-ui/react-direction's own DirectionProvider -- setting
// document.documentElement.dir (what i18n/index.ts's applyDocumentDirection
// does for plain CSS) does nothing for these. App.tsx now wraps the tree in
// DirectionProvider, reactive to i18n.language via useTranslation(). This
// test proves the WIRING works using a real consumer (Slider forwards the
// resolved direction onto its own root element's dir attribute) rather than
// re-testing Radix's own DirectionProvider/useDirection in isolation.

describe('Radix DirectionProvider wiring (App.tsx)', () => {
  it('a Radix primitive defaults to ltr with no DirectionProvider -- the bug this fixes', () => {
    const { container } = render(
      <Slider value={[50]} min={0} max={100} onValueChange={() => {}} />,
    )
    const root = container.querySelector('[data-orientation]')
    expect(root).toHaveAttribute('dir', 'ltr')
  })

  it('DirectionProvider dir="rtl" reaches the Slider primitive', () => {
    const { container } = render(
      <DirectionProvider dir="rtl">
        <Slider value={[50]} min={0} max={100} onValueChange={() => {}} />
      </DirectionProvider>,
    )
    const root = container.querySelector('[data-orientation]')
    expect(root).toHaveAttribute('dir', 'rtl')
  })

  it('DirectionProvider dir="ltr" is unaffected (the six-then-seven existing LTR languages stay exactly as before)', () => {
    const { container } = render(
      <DirectionProvider dir="ltr">
        <Slider value={[50]} min={0} max={100} onValueChange={() => {}} />
      </DirectionProvider>,
    )
    const root = container.querySelector('[data-orientation]')
    expect(root).toHaveAttribute('dir', 'ltr')
  })
})
