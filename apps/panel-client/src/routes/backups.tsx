import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Backups = lazy(() => import('../pages/Backups'))

export const Route = createFileRoute('/backups')({
  component: () => <FeatureRoute featureName="nav.items.worldBackups" Component={Backups} />,
})
