import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Scheduler = lazy(() => import('../pages/schedule/SchedulePage'))

export const Route = createFileRoute('/schedule')({
  component: () => <FeatureRoute featureName="Schedule" Component={Scheduler} />,
})
