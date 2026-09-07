import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { NotFoundRoute } from '../App'

function NavigateTo({ to, tab }: { to: '/' | '/chunks' | '/settings' | '/server-config'; tab?: string }) {
  const navigate = useNavigate()

  useEffect(() => {
    void navigate({
      to,
      ...(tab ? { search: { tab } } : {}),
      replace: true,
    })
  }, [navigate, tab, to])

  return null
}

function LegacyRoute() {
  const { pathname } = useLocation()

  if (pathname === '/dashboard') return <NavigateTo to="/" />
  if (pathname === '/chunk-cleaner') return <NavigateTo to="/chunks" />
  if (pathname === '/roles') return <NavigateTo to="/settings" tab="roles" />
  if (pathname === '/users') return <NavigateTo to="/settings" tab="users" />
  if (pathname === '/sso') return <NavigateTo to="/settings" tab="sso" />
  if (pathname === '/serverconfig') return <NavigateTo to="/server-config" />

  return <NotFoundRoute />
}

export const Route = createFileRoute('/$')({
  component: LegacyRoute,
})
