import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Console = lazy(() => import('../pages/console/ConsolePage'))

export const Route = createFileRoute('/console')({
  component: () => <FeatureRoute featureName="Console" Component={Console} />,
})
