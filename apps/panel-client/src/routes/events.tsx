import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Events = lazy(() => import('../pages/Events'))

export const Route = createFileRoute('/events')({
  component: () => <FeatureRoute featureName="nav.items.eventsWeather" Component={Events} />,
})
