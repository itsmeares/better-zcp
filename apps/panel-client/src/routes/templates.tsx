import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Templates = lazy(() => import('../pages/Templates'))

export const Route = createFileRoute('/templates')({
  component: () => <FeatureRoute featureName="nav.items.templates" Component={Templates} />,
})
