import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageSkeleton } from '../PageSkeleton'

describe('PageSkeleton', () => {
  it('announces itself as busy/loading for assistive tech, for every variant', () => {
    const variants = ['dashboard', 'list', 'form', 'console', 'map', 'default'] as const
    for (const variant of variants) {
      const { unmount } = render(<PageSkeleton variant={variant} />)
      const status = screen.getByRole('status')
      expect(status).toHaveAttribute('aria-busy', 'true')
      unmount()
    }
  })

  it('includes the real page title in the loading label when given, so it is not a generic "Loading page" for every screen', () => {
    render(<PageSkeleton variant="list" title="Backups" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading Backups')
  })

  it('falls back to a generic label when no title is given', () => {
    render(<PageSkeleton variant="form" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading form page')
  })

  it('renders a distinct structure for the dashboard variant vs. the console variant', () => {
    const { container: dash } = render(<PageSkeleton variant="dashboard" />)
    const { container: console_ } = render(<PageSkeleton variant="console" />)
    // Dashboard shows a 4-up stat grid; console does not.
    expect(dash.querySelectorAll('.grid.grid-cols-1.md\\:grid-cols-2.lg\\:grid-cols-4').length).toBe(1)
    expect(console_.querySelectorAll('.grid.grid-cols-1.md\\:grid-cols-2.lg\\:grid-cols-4').length).toBe(0)
  })
})
