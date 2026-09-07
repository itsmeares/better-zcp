import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Servers = lazy(() => import('../pages/Servers'))

export const Route = createFileRoute('/servers')({
  component: () => <FeatureRoute featureName="nav.items.myServers" Component={Servers} />,
})
