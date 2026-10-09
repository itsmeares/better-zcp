import {
  Activity,
  Archive,
  Clock,
  FileCog,
  ServerCog,
  LayoutGrid,
  Map,
  Package,
  Server,
  Settings,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react'

// One source for the sidebar, the command palette and the number-key
// shortcuts. Server pages act on the selected server; panel pages don't.
export interface NavItem {
  to: '/' | '/console' | '/players' | '/map' | '/mods' | '/config' | '/server-settings' | '/backups' | '/schedule' | '/servers' | '/diagnostics' | '/settings'
  label: string
  icon: LucideIcon
  /** Token name in styles/tokens.css (--hue-*). */
  hue: string
  requiresServer: boolean
  shortcut?: string
}

export interface NavGroup {
  label: string | null
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ to: '/', label: 'Overview', icon: LayoutGrid, hue: 'overview', requiresServer: true, shortcut: '1' }],
  },
  {
    label: 'Live',
    items: [
      { to: '/console', label: 'Console', icon: Terminal, hue: 'console', requiresServer: true, shortcut: '2' },
      { to: '/players', label: 'Players', icon: Users, hue: 'players', requiresServer: true, shortcut: '3' },
      { to: '/map', label: 'Map', icon: Map, hue: 'map', requiresServer: true, shortcut: '4' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { to: '/mods', label: 'Mods', icon: Package, hue: 'mods', requiresServer: true, shortcut: '5' },
      { to: '/config', label: 'Configuration', icon: FileCog, hue: 'config', requiresServer: true, shortcut: '6' },
      { to: '/server-settings', label: 'Server settings', icon: ServerCog, hue: 'server-settings', requiresServer: true, shortcut: '7' },
    ],
  },
  {
    label: 'Maintain',
    items: [
      { to: '/backups', label: 'Backups', icon: Archive, hue: 'backups', requiresServer: true, shortcut: '8' },
      { to: '/schedule', label: 'Schedule', icon: Clock, hue: 'schedule', requiresServer: true, shortcut: '9' },
    ],
  },
  {
    label: 'Panel',
    items: [
      { to: '/servers', label: 'Servers', icon: Server, hue: 'servers', requiresServer: false },
      { to: '/diagnostics', label: 'Diagnostics', icon: Activity, hue: 'diagnostics', requiresServer: false },
      { to: '/settings', label: 'Settings', icon: Settings, hue: 'settings', requiresServer: false },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

/** True for the item's page and pages under it, such as /servers/new. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return pathname === item.to || (item.to !== '/' && pathname.startsWith(`${item.to}/`))
}

export function findNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => isNavItemActive(item, pathname))
}
