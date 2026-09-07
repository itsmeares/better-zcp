import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Debug = lazy(() => import('../pages/Debug'))

export const Route = createFileRoute('/debug')({
  component: () => <FeatureRoute featureName="nav.items.debugLogs" Component={Debug} />,
})
