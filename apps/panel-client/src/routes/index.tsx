import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Dashboard = lazy(() => import('../pages/Dashboard'))

export const Route = createFileRoute('/')({
  component: () => <FeatureRoute featureName="nav.dashboard" Component={Dashboard} />,
})
