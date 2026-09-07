import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const WorldMap = lazy(() => import('../pages/WorldMap'))

export const Route = createFileRoute('/world-map')({
  component: () => <FeatureRoute featureName="nav.items.worldMap" Component={WorldMap} />,
})
