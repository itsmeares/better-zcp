import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusIndicator } from '../StatusIndicator'

describe('StatusIndicator', () => {
  it('renders label text', () => {
    render(<StatusIndicator state="online" label="Server Running" />)
    expect(screen.getByText('Server Running')).toBeInTheDocument()
  })

  it('has role="status" for accessibility', () => {
    render(<StatusIndicator state="offline" label="Disconnected" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders the dot as aria-hidden', () => {
    const { container } = render(<StatusIndicator state="online" label="Up" />)
    const dot = container.querySelector('[aria-hidden="true"]')
    expect(dot).toBeInTheDocument()
  })

  it.each(['online', 'offline', 'connecting', 'unknown'] as const)(
    'renders without crashing for state="%s"',
    (state) => {
      const { container } = render(<StatusIndicator state={state} label={state} />)
      expect(container.firstChild).toBeInTheDocument()
    }
  )
})
