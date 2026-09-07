import {
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
  createRouter,
} from '@tanstack/react-router'
import { isDemoMode } from './lib/demo'
import { routeTree } from './routeTree.gen'

function createPanelRouter() {
  return createRouter({
    routeTree,
    history: typeof window === 'undefined'
      ? createMemoryHistory({ initialEntries: ['/'] })
      : isDemoMode() ? createHashHistory() : createBrowserHistory(),
    defaultPendingMs: 100,
    scrollRestoration: true,
  })
}

export const router = createPanelRouter()

export function getRouter() {
  return typeof window === 'undefined' ? createPanelRouter() : router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
