import type { ComponentType } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'

export function FeatureRoute({ featureName, Component }: { featureName: string; Component: ComponentType }) {
  return (
    <ErrorBoundary featureName={featureName}>
      <Component />
    </ErrorBoundary>
  )
}
