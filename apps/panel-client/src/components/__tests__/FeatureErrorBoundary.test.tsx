import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { FeatureErrorBoundary } from '../FeatureErrorBoundary'
import en from '@/locales/en/featureErrorBoundary.json'

const widgetErrorTitle = en.titleSuffix.replace('{{featureName}}', 'Widget')
const widgetCompactMessage = en.compactMessage.replace('{{featureName}}', 'Widget')

const originalConsoleError = console.error
beforeEach(() => {
  console.error = vi.fn()
})
afterEach(() => {
  console.error = originalConsoleError
})

// Throws only while `shouldThrow.current` is true, so a single instance can be
// flipped to "recovered" across a Try Again re-render.
function Flaky({ shouldThrow }: { shouldThrow: { current: boolean } }) {
  if (shouldThrow.current) throw new Error('feature exploded')
  return <p>Feature content</p>
}

describe('FeatureErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(
      <MemoryRouter>
        <FeatureErrorBoundary featureName="Widget">
          <p>All good</p>
        </FeatureErrorBoundary>
      </MemoryRouter>
    )
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  it('catches a thrown error and reports it instead of crashing the app', () => {
    const shouldThrow = { current: true }
    render(
      <MemoryRouter>
        <FeatureErrorBoundary featureName="Widget">
          <Flaky shouldThrow={shouldThrow} />
        </FeatureErrorBoundary>
      </MemoryRouter>
    )
    expect(screen.getByText(widgetErrorTitle)).toBeInTheDocument()
    expect(screen.getByText('feature exploded')).toBeInTheDocument()
  })

  it('calls the onError callback with the real error', () => {
    const onError = vi.fn()
    render(
      <MemoryRouter>
        <FeatureErrorBoundary featureName="Widget" onError={onError}>
          <Flaky shouldThrow={{ current: true }} />
        </FeatureErrorBoundary>
      </MemoryRouter>
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0][0].message).toBe('feature exploded')
  })

  it('renders a compact fallback without the error message body', () => {
    render(
      <MemoryRouter>
        <FeatureErrorBoundary featureName="Widget" compact>
          <Flaky shouldThrow={{ current: true }} />
        </FeatureErrorBoundary>
      </MemoryRouter>
    )
    expect(screen.getByText(widgetCompactMessage)).toBeInTheDocument()
    expect(screen.queryByText('feature exploded')).not.toBeInTheDocument()
  })

  it('renders a custom fallback when provided, instead of the default UI', () => {
    render(
      <MemoryRouter>
        <FeatureErrorBoundary fallback={<p>Custom fallback</p>}>
          <Flaky shouldThrow={{ current: true }} />
        </FeatureErrorBoundary>
      </MemoryRouter>
    )
    expect(screen.getByText('Custom fallback')).toBeInTheDocument()
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument()
  })

  it('Try Again actually clears the error and shows real recovered content, not just a reset flag', () => {
    const shouldThrow = { current: true }
    render(
      <MemoryRouter>
        <FeatureErrorBoundary featureName="Widget">
          <Flaky shouldThrow={shouldThrow} />
        </FeatureErrorBoundary>
      </MemoryRouter>
    )
    expect(screen.getByText(widgetErrorTitle)).toBeInTheDocument()

    // Simulate the underlying cause having cleared before the retry.
    shouldThrow.current = false
    fireEvent.click(screen.getByRole('button', { name: en.tryAgain }))

    expect(screen.getByText('Feature content')).toBeInTheDocument()
    expect(screen.queryByText(widgetErrorTitle)).not.toBeInTheDocument()
  })

  it('Try Again re-shows the error UI if the underlying cause is still present', () => {
    const shouldThrow = { current: true }
    render(
      <MemoryRouter>
        <FeatureErrorBoundary featureName="Widget">
          <Flaky shouldThrow={shouldThrow} />
        </FeatureErrorBoundary>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: en.tryAgain }))
    expect(screen.getByText(widgetErrorTitle)).toBeInTheDocument()
  })
})
