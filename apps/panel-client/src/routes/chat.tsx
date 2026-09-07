import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Chat = lazy(() => import('../pages/Chat'))

export const Route = createFileRoute('/chat')({
  component: () => <FeatureRoute featureName="nav.items.inGameChat" Component={Chat} />,
})
