import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const ServerSetup = lazy(() => import('../pages/ServerSetup'))

export const Route = createFileRoute('/server-setup')({
  component: () => <FeatureRoute featureName="nav.items.serverSetup" Component={ServerSetup} />,
})
