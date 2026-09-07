import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const ServerConfig = lazy(() => import('../pages/ServerConfig'))

export const Route = createFileRoute('/server-config')({
  component: () => <FeatureRoute featureName="nav.items.serverConfiguration" Component={ServerConfig} />,
})
