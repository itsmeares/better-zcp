import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EmptyState } from '../EmptyState'

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(<EmptyState title="No servers found" description="Add a server to get started." />)
    expect(screen.getByText('No servers found')).toBeInTheDocument()
    expect(screen.getByText('Add a server to get started.')).toBeInTheDocument()
  })

  it('renders eyebrow text for the given type', () => {
    render(<EmptyState type="noPlayers" title="Ghost town" />)
    expect(screen.getByText('No Players Online')).toBeInTheDocument()
  })

  // bug-hunt-2026-08-31: 8 permission-denied call sites across the app
  // override `icon` to ShieldAlert but had no matching `type`, so this
  // eyebrow fell through to the 'noData' default -- "No Data" rendered
  // directly under an icon whose whole point is "you're not allowed to see
  // this", the opposite claim. `accessDenied` gives them their own eyebrow.
  it('renders the accessDenied eyebrow, not the noData default it used to fall through to', () => {
    render(<EmptyState type="accessDenied" title="You can't manage user accounts" />)
    expect(screen.getByText('Access Denied')).toBeInTheDocument()
    expect(screen.queryByText('No Data')).not.toBeInTheDocument()
  })

  it('renders action button when provided', () => {
    const onClick = () => {}
    render(
      <EmptyState
        title="Nothing here"
        action={{ label: 'Add Server', onClick }}
      />
    )
    expect(screen.getByRole('button', { name: 'Add Server' })).toBeInTheDocument()
  })

  it('does not render action button when omitted', () => {
    render(<EmptyState title="Nothing here" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('accepts a ReactNode description, not just a plain string -- the seam that lets a HelpTip live inside empty-state body copy', () => {
    render(
      <EmptyState
        title="Mod settings not loaded"
        description={<span>Fetch options via <button type="button">PanelBridge</button></span>}
      />
    )
    expect(screen.getByText(/Fetch options via/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'PanelBridge' })).toBeInTheDocument()
  })

  it('renders compact variant with smaller padding', () => {
    const { container } = render(<EmptyState title="Compact" compact />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('py-8')
  })

  it('has an accessible live region', () => {
    const { container } = render(<EmptyState title="Test" />)
    const liveRegion = container.querySelector('[aria-live="polite"]')
    expect(liveRegion).toBeInTheDocument()
  })

  it('renders action as a real link to an internal destination when given `to` instead of `onClick` -- the whole reason this widened: a hint pointing at another screen previously had nowhere to send the click', () => {
    render(
      <MemoryRouter>
        <EmptyState title="Bridge not configured" action={{ label: 'Go to Settings', to: '/settings?tab=bridge' }} />
      </MemoryRouter>
    )
    const link = screen.getByRole('link', { name: 'Go to Settings' })
    expect(link).toHaveAttribute('href', '/settings?tab=bridge')
  })

  it('defaults secondaryAction to the ghost variant like before, even when it links out via `to`', () => {
    render(
      <MemoryRouter>
        <EmptyState
          title="Nothing here"
          action={{ label: 'Retry', onClick: () => {} }}
          secondaryAction={{ label: 'Learn more', to: '/settings' }}
        />
      </MemoryRouter>
    )
    const link = screen.getByRole('link', { name: 'Learn more' })
    expect(link.closest('button, a')).toBeTruthy()
  })
})
