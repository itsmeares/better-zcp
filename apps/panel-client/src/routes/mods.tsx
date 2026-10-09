import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const ModsPage = lazy(() => import('../pages/mods/ModsPage'))

const VIEWS = ['items', 'ids', 'order', 'conflicts', 'not-loaded', 'collection', 'tools'] as const
export type ModsView = (typeof VIEWS)[number]

export const Route = createFileRoute('/mods')({
  validateSearch: (search: Record<string, unknown>): { view?: ModsView } => ({
    view: VIEWS.includes(search.view as ModsView) ? (search.view as ModsView) : undefined,
  }),
  component: () => <FeatureRoute featureName="Mods" Component={ModsPage} />,
})
