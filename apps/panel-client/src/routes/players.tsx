import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Players = lazy(() => import('../pages/players/PlayersPage'))

export const Route = createFileRoute('/players')({
  validateSearch: (search: Record<string, unknown>): { player?: string } => ({ player: typeof search.player === 'string' ? search.player : undefined }),
  component: () => <FeatureRoute featureName="Players" Component={Players} />,
})
