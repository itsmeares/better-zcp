import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const ServerSettings = lazy(() => import('../pages/server-settings/ServerSettingsPage'))

export const Route = createFileRoute('/server-settings')({
  component: () => <FeatureRoute featureName="Server settings" Component={ServerSettings} />,
})
