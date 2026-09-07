import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const ChunkCleaner = lazy(() => import('../pages/ChunkCleaner'))

export const Route = createFileRoute('/chunks')({
  component: () => <FeatureRoute featureName="nav.items.mapCleanup" Component={ChunkCleaner} />,
})
