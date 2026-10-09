import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const DiagnosticsPage = lazy(() => import('../pages/diagnostics/DiagnosticsPage'))

const TABS = ['checks', 'activity', 'log', 'crashes', 'map', 'health'] as const
export type DiagnosticsTab = (typeof TABS)[number]

export const Route = createFileRoute('/diagnostics')({
  validateSearch: (search: Record<string, unknown>): { tab?: DiagnosticsTab } => ({
    tab: TABS.includes(search.tab as DiagnosticsTab) ? (search.tab as DiagnosticsTab) : undefined,
  }),
  component: () => <FeatureRoute featureName="Diagnostics" Component={DiagnosticsPage} />,
})
