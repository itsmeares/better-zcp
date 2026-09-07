import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { FeatureErrorBoundary } from './components/FeatureErrorBoundary'

export function FeatureRoute({ featureName, Component }: { featureName: string; Component: ComponentType }) {
  const { t } = useTranslation('shell')
  return (
    <FeatureErrorBoundary featureName={t(featureName)}>
      <Component />
    </FeatureErrorBoundary>
  )
}
