import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Servers = lazy(() => import('../pages/servers/ServersPage'))

export const Route = createFileRoute('/servers')({
  component: () => <FeatureRoute featureName="Servers" Component={Servers} />,
})
