import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Settings = lazy(() => import('../pages/Settings'))

export const Route = createFileRoute('/settings')({
  component: () => <FeatureRoute featureName="nav.items.panelSettings" Component={Settings} />,
})
