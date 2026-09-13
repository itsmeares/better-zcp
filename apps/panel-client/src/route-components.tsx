import type { ComponentType } from 'react'
import { FeatureErrorBoundary } from './components/FeatureErrorBoundary'

export function FeatureRoute({
  featureName,
  Component,
}: {
  featureName: string
  Component: ComponentType
}) {
  return (
    <FeatureErrorBoundary featureName={featureName}>
      <Component />
    </FeatureErrorBoundary>
  )
}
