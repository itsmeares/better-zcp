import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link as TanStackLink,
  Outlet,
  RouterContextProvider,
  useLocation as useTanStackLocation,
  useNavigate as useTanStackNavigate,
} from '@tanstack/react-router'
import { useCallback, useMemo, useEffect, type AnchorHTMLAttributes, type ReactNode } from 'react'

type NavigationOptions = {
  replace?: boolean
}

type RouterLocation = {
  pathname: string
  search: string
  searchStr: string
  hash: string
}

type SearchParamsInit = ConstructorParameters<typeof URLSearchParams>[0]
type SearchParamsSetter = (
  nextInit: SearchParamsInit | ((current: URLSearchParams) => URLSearchParams),
  options?: NavigationOptions,
) => void

type InternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'children'> & {
  to: string
  replace?: boolean
  children?: ReactNode
}

function parseDestination(to: string) {
  const url = new URL(to, 'http://zcp.local')
  const search = Object.fromEntries(new URLSearchParams(url.search).entries())
  return {
    pathname: url.pathname || '/',
    search: Object.keys(search).length > 0 ? search : {},
    hash: url.hash || undefined,
  }
}

export function Link({ to, replace, ...props }: InternalLinkProps) {
  const destination = parseDestination(to)
  return (
    <TanStackLink
      to={destination.pathname as never}
      search={destination.search as never}
      hash={destination.hash}
      replace={replace}
      {...props}
    />
  )
}

type NavLinkState = { isActive: boolean; isPending: boolean }
type NavLinkProps = Omit<InternalLinkProps, 'className' | 'children'> & {
  end?: boolean
  className?: string | ((state: NavLinkState) => string)
  children?: ReactNode | ((state: NavLinkState) => ReactNode)
}

export function NavLink({ to, end = false, className, children, ...props }: NavLinkProps) {
  const { pathname } = useLocation()
  const targetPath = parseDestination(to).pathname.replace(/\/$/, '') || '/'
  const currentPath = pathname.replace(/\/$/, '') || '/'
  const isActive = end
    ? currentPath === targetPath
    : currentPath === targetPath || currentPath.startsWith(`${targetPath}/`)
  const state = { isActive, isPending: false }
  const resolvedClassName = typeof className === 'function' ? className(state) : className
  const resolvedChildren = typeof children === 'function' ? children(state) : children

  return (
    <Link to={to} className={resolvedClassName} {...props}>
      {resolvedChildren}
    </Link>
  )
}

export function useLocation(): RouterLocation {
  const location = useTanStackLocation()
  return {
    pathname: location.pathname,
    search: location.searchStr,
    searchStr: location.searchStr,
    hash: location.hash,
  }
}

export function useNavigate() {
  const navigate = useTanStackNavigate()
  return useCallback(
    (to: string, options: NavigationOptions = {}) => {
      const destination = parseDestination(to)
      return navigate({
        to: destination.pathname as never,
        search: destination.search as never,
        hash: destination.hash,
        replace: options.replace,
      })
    },
    [navigate],
  )
}

export function Navigate({ to, replace = false }: { to: string; replace?: boolean }) {
  const navigate = useNavigate()
  useEffect(() => {
    void navigate(to, { replace })
  }, [navigate, replace, to])
  return null
}

export function useSearchParams(): [URLSearchParams, SearchParamsSetter] {
  const location = useTanStackLocation()
  const navigate = useTanStackNavigate()
  const params = useMemo(() => new URLSearchParams(location.searchStr), [location.searchStr])
  const setSearchParams = useCallback<SearchParamsSetter>(
    (nextInit, options = {}) => {
      const nextParams = typeof nextInit === 'function'
        ? nextInit(new URLSearchParams(location.searchStr))
        : new URLSearchParams(nextInit)
      const search = Object.fromEntries(nextParams.entries())
      void navigate({
        to: location.pathname as never,
        search: search as never,
        hash: location.hash || undefined,
        replace: options.replace,
      })
    },
    [location.hash, location.pathname, location.searchStr, navigate],
  )
  return [params, setSearchParams]
}

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
      history: createMemoryHistory({ initialEntries }),
    }),
    [entryKey],
  )

  return (
    <RouterContextProvider router={router}>{children}</RouterContextProvider>
  )
}

export { Outlet }
