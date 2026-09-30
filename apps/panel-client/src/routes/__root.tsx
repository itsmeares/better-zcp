import { QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, retainSearchParams, useSearch } from '@tanstack/react-router'
import { BuildCompatibilityGate } from '../components/BuildCompatibilityGate'
import { PageSkeleton } from '../components/PageSkeleton'
import AppShell from '../AppShell'
import { NotFoundRoute } from '../components/NotFoundRoute'
import { queryClientFor } from '../lib/queryClient'
import '../index.css'

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): { server?: string } => ({
    server: typeof search.server === 'string' && /^[A-Za-z0-9_-]+$/.test(search.server) ? search.server : undefined,
  }),
  search: { middlewares: [retainSearchParams(['server'])] },
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
  const { server } = useSearch({ from: '__root__' })
  const client = queryClientFor(server ?? null)
  return (
    <QueryClientProvider client={client}>
      <BuildCompatibilityGate>
        <AppShell />
      </BuildCompatibilityGate>
    </QueryClientProvider>
  )
}
