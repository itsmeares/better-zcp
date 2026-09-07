import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Players = lazy(() => import('../pages/Players'))

export const Route = createFileRoute('/players')({
  component: () => <FeatureRoute featureName="nav.items.onlinePlayers" Component={Players} />,
})
