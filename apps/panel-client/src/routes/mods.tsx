import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Mods = lazy(() => import('../pages/Mods'))

export const Route = createFileRoute('/mods')({
  component: () => <FeatureRoute featureName="nav.items.modManager" Component={Mods} />,
})
