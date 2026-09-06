import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HelpTip } from '../HelpTip'

function renderTip(children = 'Explains the thing.') {
  return render(
    <TooltipProvider>
      <HelpTip label="Widget Name">{children}</HelpTip>
    </TooltipProvider>,
  )
}

describe('HelpTip', () => {
  it('has a distinguishing accessible name naming the field it explains, not a bare icon', () => {
    renderTip()
    expect(screen.getByRole('button', { name: 'Help: Widget Name' })).toBeInTheDocument()
  })

  it('is reachable and toggleable by keyboard, not just a mouse hover target', async () => {
    renderTip()
    const trigger = screen.getByRole('button', { name: 'Help: Widget Name' })
    expect(document.body).not.toHaveTextContent('Explains the thing.')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByText('Explains the thing.')).toBeInTheDocument())
  })

  it('opens on a plain click — the touch path, which has no hover state to fall back on', async () => {
    renderTip('Tap-to-open content.')
    const trigger = screen.getByRole('button', { name: 'Help: Widget Name' })
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByText('Tap-to-open content.')).toBeInTheDocument())
  })

  it('renders nothing extra until opened', () => {
    renderTip('Hidden until opened.')
    expect(screen.queryByText('Hidden until opened.')).not.toBeInTheDocument()
  })
})
