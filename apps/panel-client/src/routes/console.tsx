import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Console = lazy(() => import('../pages/Console'))

export const Route = createFileRoute('/console')({
  component: () => <FeatureRoute featureName="nav.items.serverConsole" Component={Console} />,
})
