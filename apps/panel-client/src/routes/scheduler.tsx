import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Scheduler = lazy(() => import('../pages/Scheduler'))

export const Route = createFileRoute('/scheduler')({
  component: () => <FeatureRoute featureName="nav.items.scheduledTasks" Component={Scheduler} />,
})
