import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const Settings = lazy(() => import('../pages/settings/SettingsPage'))

export const Route = createFileRoute('/settings')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({ tab: typeof search.tab === 'string' ? search.tab : undefined }),
  component: () => <FeatureRoute featureName="nav.items.panelSettings" Component={Settings} />,
})
