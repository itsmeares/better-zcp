import { createFileRoute } from '@tanstack/react-router'
import { NotFoundRoute } from '../App'
import { Navigate, useLocation } from '../lib/routerCompat'

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

  return <NotFoundRoute />
}

export const Route = createFileRoute('/$')({
  component: LegacyRoute,
})
