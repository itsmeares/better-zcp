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
