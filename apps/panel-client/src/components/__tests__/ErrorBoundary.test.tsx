import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from '../ErrorBoundary'
import en from '@/locales/en/errorBoundary.json'

// Suppress React error boundary console noise during tests
const originalConsoleError = console.error
beforeEach(() => {
  console.error = vi.fn()
})
afterEach(() => {
  console.error = originalConsoleError
})

function ThrowingChild({ message }: { message: string }) {
  throw new Error(message)
}

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>
    )
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  it('renders error UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="kaboom" />
      </ErrorBoundary>
    )
    expect(screen.getByText(en.title)).toBeInTheDocument()
    expect(screen.getByText('kaboom')).toBeInTheDocument()
  })

  it('shows Refresh Page and Try Again buttons', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="test error" />
      </ErrorBoundary>
    )
    expect(screen.getByRole('button', { name: en.refreshPage })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.tryAgain })).toBeInTheDocument()
  })
})
