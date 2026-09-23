const routeLoaders: Record<string, () => Promise<unknown>> = {
  '/': () => import('../pages/Dashboard'),
  '/players': () => import('../pages/Players'),
  '/console': () => import('../pages/Console'),
  '/scheduler': () => import('../pages/Scheduler'),
  '/mods': () => import('../pages/Mods'),
  '/settings': () => import('../pages/Settings'),
  '/server-setup': () => import('../pages/ServerSetup'),
  '/servers': () => import('../pages/Servers'),
  '/server-config': () => import('../pages/ServerConfig'),
  '/debug': () => import('../pages/Debug'),
  '/world-map': () => import('../pages/WorldMap'),
  '/backups': () => import('../pages/Backups'),
}

const routeAliases: Record<string, string> = {
  '/dashboard': '/',
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
