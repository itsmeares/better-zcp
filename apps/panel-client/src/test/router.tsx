import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterContextProvider,
} from '@tanstack/react-router'
import { useMemo, type ReactNode } from 'react'

const memoryRootRoute = createRootRoute({
  component: () => <Outlet />,
})
const memoryCatchAllRoute = createRoute({
  getParentRoute: () => memoryRootRoute,
  path: '$',
  component: () => null,
})
const memoryRouteTree = memoryRootRoute.addChildren([memoryCatchAllRoute])

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
    <RouterContextProvider router={router}>{children}</RouterContextProvider>
  )
}
