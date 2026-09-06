import {
  createBrowserHistory,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router'
import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { FeatureErrorBoundary } from './components/FeatureErrorBoundary'
import { PageSkeleton } from './components/PageSkeleton'
import App, { NotFoundRoute } from './App'
import { isDemoMode } from './lib/demo'
import { Navigate } from './lib/router'

const rootRoute = createRootRoute({
  component: App,
  notFoundComponent: NotFoundRoute,
  pendingComponent: () => <PageSkeleton title="Loading" description="Opening panel route." eyebrow="// ROUTE" variant="default" metrics={['route']} />,
})

function FeatureRoute({ featureName, Component }: { featureName: string; Component: ComponentType }) {
  const { t } = useTranslation('shell')
  return (
    <FeatureErrorBoundary featureName={t(featureName)}>
      <Component />
    </FeatureErrorBoundary>
  )
}

function featureRoute(
  path: string,
  featureName: string,
  importer: () => Promise<{ default: ComponentType }>,
) {
  const Component = lazyRouteComponent(importer)
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <FeatureRoute featureName={featureName} Component={Component} />,
  })
}

const indexRoute = featureRoute('/', 'nav.dashboard', () => import('./pages/Dashboard'))
const dashboardAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'dashboard',
  component: () => <NavigateTo to="/" />,
})
const playersRoute = featureRoute('players', 'nav.items.onlinePlayers', () => import('./pages/Players'))
const consoleRoute = featureRoute('console', 'nav.items.serverConsole', () => import('./pages/Console'))
const schedulerRoute = featureRoute('scheduler', 'nav.items.scheduledTasks', () => import('./pages/Scheduler'))
const modsRoute = featureRoute('mods', 'nav.items.modManager', () => import('./pages/Mods'))
const templatesRoute = featureRoute('templates', 'nav.items.templates', () => import('./pages/Templates'))
const chunksRoute = featureRoute('chunks', 'nav.items.mapCleanup', () => import('./pages/ChunkCleaner'))
const chunkCleanerAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'chunk-cleaner',
  component: () => <NavigateTo to="/chunks" />,
})
const discordRoute = featureRoute('discord', 'nav.items.discord', () => import('./pages/Discord'))
const settingsRoute = featureRoute('settings', 'nav.items.panelSettings', () => import('./pages/Settings'))
const rolesAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'roles',
  component: () => <NavigateTo to="/settings?tab=roles" />,
})
const usersAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'users',
  component: () => <NavigateTo to="/settings?tab=users" />,
})
const ssoAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sso',
  component: () => <NavigateTo to="/settings?tab=sso" />,
})
const serverSetupRoute = featureRoute('server-setup', 'nav.items.serverSetup', () => import('./pages/ServerSetup'))
const serversRoute = featureRoute('servers', 'nav.items.myServers', () => import('./pages/Servers'))
const serverConfigRoute = featureRoute('server-config', 'nav.items.serverConfiguration', () => import('./pages/ServerConfig'))
const serverConfigAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'serverconfig',
  component: () => <NavigateTo to="/server-config" />,
})
const serverFinderRoute = featureRoute('server-finder', 'nav.items.browsePublic', () => import('./pages/ServerFinder'))
const debugRoute = featureRoute('debug', 'nav.items.debugLogs', () => import('./pages/Debug'))
const eventsRoute = featureRoute('events', 'nav.items.eventsWeather', () => import('./pages/Events'))
const worldMapRoute = featureRoute('world-map', 'nav.items.worldMap', () => import('./pages/WorldMap'))
const chatRoute = featureRoute('chat', 'nav.items.inGameChat', () => import('./pages/Chat'))
const backupsRoute = featureRoute('backups', 'nav.items.worldBackups', () => import('./pages/Backups'))

function NavigateTo({ to }: { to: string }) {
  return <Navigate to={to} replace />
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardAliasRoute,
  playersRoute,
  consoleRoute,
  schedulerRoute,
  modsRoute,
  templatesRoute,
  chunksRoute,
  chunkCleanerAliasRoute,
  discordRoute,
  settingsRoute,
  rolesAliasRoute,
  usersAliasRoute,
  ssoAliasRoute,
  serverSetupRoute,
  serversRoute,
  serverConfigRoute,
  serverConfigAliasRoute,
  serverFinderRoute,
  debugRoute,
  eventsRoute,
  worldMapRoute,
  chatRoute,
  backupsRoute,
])

export const router = createRouter({
  routeTree,
  history: isDemoMode() ? createHashHistory() : createBrowserHistory(),
  defaultPendingMs: 100,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
