import { createFileRoute } from '@tanstack/react-router'
import { lazy, type ComponentType } from 'react'
import { NotFoundRoute } from '../App'
import { FeatureRoute } from '../route-components'
import { Navigate, useLocation } from '../lib/router'

const Players = lazy(() => import('../pages/Players'))
const Console = lazy(() => import('../pages/Console'))
const Scheduler = lazy(() => import('../pages/Scheduler'))
const Mods = lazy(() => import('../pages/Mods'))
const Templates = lazy(() => import('../pages/Templates'))
const ChunkCleaner = lazy(() => import('../pages/ChunkCleaner'))
const Discord = lazy(() => import('../pages/Discord'))
const Settings = lazy(() => import('../pages/Settings'))
const ServerSetup = lazy(() => import('../pages/ServerSetup'))
const Servers = lazy(() => import('../pages/Servers'))
const ServerConfig = lazy(() => import('../pages/ServerConfig'))
const ServerFinder = lazy(() => import('../pages/ServerFinder'))
const Debug = lazy(() => import('../pages/Debug'))
const Events = lazy(() => import('../pages/Events'))
const WorldMap = lazy(() => import('../pages/WorldMap'))
const Chat = lazy(() => import('../pages/Chat'))
const Backups = lazy(() => import('../pages/Backups'))

type Feature = {
  featureName: string
  Component: ComponentType
}

const FEATURES: Record<string, Feature> = {
  '/players': { featureName: 'nav.items.onlinePlayers', Component: Players },
  '/console': { featureName: 'nav.items.serverConsole', Component: Console },
  '/scheduler': { featureName: 'nav.items.scheduledTasks', Component: Scheduler },
  '/mods': { featureName: 'nav.items.modManager', Component: Mods },
  '/templates': { featureName: 'nav.items.templates', Component: Templates },
  '/chunks': { featureName: 'nav.items.mapCleanup', Component: ChunkCleaner },
  '/discord': { featureName: 'nav.items.discord', Component: Discord },
  '/settings': { featureName: 'nav.items.panelSettings', Component: Settings },
  '/server-setup': { featureName: 'nav.items.serverSetup', Component: ServerSetup },
  '/servers': { featureName: 'nav.items.myServers', Component: Servers },
  '/server-config': { featureName: 'nav.items.serverConfiguration', Component: ServerConfig },
  '/server-finder': { featureName: 'nav.items.browsePublic', Component: ServerFinder },
  '/debug': { featureName: 'nav.items.debugLogs', Component: Debug },
  '/events': { featureName: 'nav.items.eventsWeather', Component: Events },
  '/world-map': { featureName: 'nav.items.worldMap', Component: WorldMap },
  '/chat': { featureName: 'nav.items.inGameChat', Component: Chat },
  '/backups': { featureName: 'nav.items.worldBackups', Component: Backups },
}

function NavigateTo({ to }: { to: string }) {
  return <Navigate to={to} replace />
}

function LegacyRoute() {
  const { pathname } = useLocation()

  if (pathname === '/dashboard') return <NavigateTo to="/" />
  if (pathname === '/chunk-cleaner') return <NavigateTo to="/chunks" />
  if (pathname === '/roles') return <NavigateTo to="/settings?tab=roles" />
  if (pathname === '/users') return <NavigateTo to="/settings?tab=users" />
  if (pathname === '/sso') return <NavigateTo to="/settings?tab=sso" />
  if (pathname === '/serverconfig') return <NavigateTo to="/server-config" />

  const feature = FEATURES[pathname]
  return feature
    ? <FeatureRoute featureName={feature.featureName} Component={feature.Component} />
    : <NotFoundRoute />
}

export const Route = createFileRoute('/$')({
  component: LegacyRoute,
})
