import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const ServerConfig = lazy(() => import('../pages/ServerConfig'))

export const Route = createFileRoute('/config')({
  component: () => <FeatureRoute featureName="Configuration" Component={ServerConfig} />,
})
