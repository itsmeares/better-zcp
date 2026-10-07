import { createFileRoute, Navigate, useLocation } from '@tanstack/react-router'
import { NotFoundRoute } from '../components/NotFoundRoute'

// Paths from before 3.0, so bookmarks and old links keep working.
const MOVED = {
  '/dashboard': '/',
  '/world-map': '/map',
  '/server-config': '/config',
  '/serverconfig': '/config',
  '/scheduler': '/schedule',
  '/debug': '/diagnostics',
} as const

function LegacyRoute() {
  const { pathname, search } = useLocation()
  const to = MOVED[pathname as keyof typeof MOVED]
  if (!to) return <NotFoundRoute />
  return <Navigate to={to} search={search as never} replace />
}

export const Route = createFileRoute('/$')({
  component: LegacyRoute,
})
