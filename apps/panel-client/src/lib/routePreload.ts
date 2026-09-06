const routeLoaders: Record<string, () => Promise<unknown>> = {
  '/': () => import('../pages/Dashboard'),
  '/players': () => import('../pages/Players'),
  '/console': () => import('../pages/Console'),
  '/scheduler': () => import('../pages/Scheduler'),
  '/mods': () => import('../pages/Mods'),
  '/chunks': () => import('../pages/ChunkCleaner'),
  '/discord': () => import('../pages/Discord'),
  '/settings': () => import('../pages/Settings'),
  '/server-setup': () => import('../pages/ServerSetup'),
  '/servers': () => import('../pages/Servers'),
  '/server-config': () => import('../pages/ServerConfig'),
  '/server-finder': () => import('../pages/ServerFinder'),
  '/debug': () => import('../pages/Debug'),
  '/events': () => import('../pages/Events'),
  '/world-map': () => import('../pages/WorldMap'),
  '/chat': () => import('../pages/Chat'),
  '/backups': () => import('../pages/Backups'),
  '/templates': () => import('../pages/Templates'),
}

const routeAliases: Record<string, string> = {
  '/dashboard': '/',
  '/chunk-cleaner': '/chunks',
  '/serverconfig': '/server-config',
}

const preloadedRoutes = new Set<string>()

export function preloadRouteModule(pathname: string) {
  const normalizedPath = routeAliases[pathname] || pathname
  const loader = routeLoaders[normalizedPath]
  if (!loader || preloadedRoutes.has(normalizedPath)) return

  preloadedRoutes.add(normalizedPath)
  void loader().catch(() => {
    preloadedRoutes.delete(normalizedPath)
  })
}