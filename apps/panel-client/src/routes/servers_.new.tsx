import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const AddServer = lazy(() => import('../pages/add-server/AddServerPage'))

export const Route = createFileRoute('/servers_/new')({
  component: () => <FeatureRoute featureName="Add a server" Component={AddServer} />,
})
