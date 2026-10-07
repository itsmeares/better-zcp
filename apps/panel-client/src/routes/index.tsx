import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Overview = lazy(() => import('../pages/overview/OverviewPage'))

export const Route = createFileRoute('/')({
  component: () => <FeatureRoute featureName="Overview" Component={Overview} />,
})
