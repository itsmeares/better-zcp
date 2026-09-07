import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const ServerFinder = lazy(() => import('../pages/ServerFinder'))

export const Route = createFileRoute('/server-finder')({
  component: () => <FeatureRoute featureName="nav.items.browsePublic" Component={ServerFinder} />,
})
