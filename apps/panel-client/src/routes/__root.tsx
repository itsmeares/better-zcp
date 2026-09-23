import { QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute } from '@tanstack/react-router'
import { BuildCompatibilityGate } from '../components/BuildCompatibilityGate'
import { PageSkeleton } from '../components/PageSkeleton'
import AppShell from '../AppShell'
import { NotFoundRoute } from '../components/NotFoundRoute'
import { queryClient } from '../lib/queryClient'
import '../index.css'

export const Route = createRootRoute({
  component: PanelRoot,
  notFoundComponent: NotFoundRoute,
  pendingComponent: () => (
    <PageSkeleton
      title="Loading"
      description="Opening panel route."
      eyebrow="// ROUTE"
      variant="default"
      metrics={['route']}
    />
  ),
})

function PanelRoot() {
  return (
    <QueryClientProvider client={queryClient}>
      <BuildCompatibilityGate>
        <AppShell />
      </BuildCompatibilityGate>
    </QueryClientProvider>
  )
}
