import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const ConfigPage = lazy(() => import('../pages/config/ConfigPage'))

const TABS = ['ini', 'sandbox', 'spawnpoints', 'spawnregions', 'modsettings'] as const
export type ConfigTab = (typeof TABS)[number]

export const Route = createFileRoute('/config')({
  validateSearch: (search: Record<string, unknown>): { tab?: ConfigTab; search?: string } => ({
    tab: TABS.includes(search.tab as ConfigTab) ? (search.tab as ConfigTab) : undefined,
    search: typeof search.search === 'string' ? search.search.trim().slice(0, 100) || undefined : undefined,
  }),
  component: () => <FeatureRoute featureName="Configuration" Component={ConfigPage} />,
})
