import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterContextProvider,
} from '@tanstack/react-router'
import {
  QueryClient,
  QueryClientContext,
  QueryClientProvider,
} from '@tanstack/react-query'
import { useContext, useMemo, type ReactNode } from 'react'

const memoryRootRoute = createRootRoute({
  component: () => <Outlet />,
})
const memoryCatchAllRoute = createRoute({
  getParentRoute: () => memoryRootRoute,
  path: '$',
  component: () => null,
})
const memoryRouteTree = memoryRootRoute.addChildren([memoryCatchAllRoute])

function QueryProviderIfNeeded({ children }: { children: ReactNode }) {
  const parentClient = useContext(QueryClientContext)
  const testClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
    [],
  )

  if (parentClient) return <>{children}</>
  return <QueryClientProvider client={testClient}>{children}</QueryClientProvider>
}

export function MemoryRouter({
  children,
  initialEntries = ['/'],
}: {
  children?: ReactNode
  initialEntries?: string[]
}) {
  const entryKey = initialEntries.join('\u0000')
  const router = useMemo(
    () => createRouter({
      routeTree: memoryRouteTree,
      history: createMemoryHistory({ initialEntries: entryKey.split('\u0000') }),
    }),
    [entryKey],
  )

  return (
    <QueryProviderIfNeeded>
      <RouterContextProvider router={router}>{children}</RouterContextProvider>
    </QueryProviderIfNeeded>
  )
}
