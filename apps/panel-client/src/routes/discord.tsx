import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Discord = lazy(() => import('../pages/Discord'))

export const Route = createFileRoute('/discord')({
  component: () => <FeatureRoute featureName="nav.items.discord" Component={Discord} />,
})
