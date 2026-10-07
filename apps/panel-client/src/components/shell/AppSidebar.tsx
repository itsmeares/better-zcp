import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { Check, ChevronsUpDown, Github, Keyboard, LogOut, Plus, Server } from 'lucide-react'
import { selectServer } from '@/lib/serverSelection'
import { useAuth } from '@/contexts/AuthContext'
import { cn } from '@/lib/utils'
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { toastManager } from '@/components/ui/toast'
import { ConnectionStatus } from '@/components/ConnectionStatus'
import { NAV_GROUPS, type NavItem } from './nav'
import { NavTile } from './NavTile'
import type { ServerRunState, ShellStatus } from './useShellStatus'

const RUN_STATE: Record<ServerRunState, { label: string; dot: string }> = {
  running: { label: 'Running', dot: 'bg-success' },
  stopped: { label: 'Stopped', dot: 'bg-muted-foreground/60' },
  transitioning: { label: 'Starting or stopping', dot: 'bg-warning' },
  unknown: { label: 'Status unknown', dot: 'bg-muted-foreground/40' },
}

const NO_SERVER_REASON = 'Add a server first. This page needs one to work with.'

function countLabel(count: number) {
  return count > 99 ? '99+' : String(count)
}

function ServerSwitcher({ status }: { status: ShellStatus }) {
  const navigate = useNavigate()
  const { servers, selectedServer, runState, playerCount } = status
  const state = RUN_STATE[runState]

  if (!servers || servers.length === 0) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" tooltip="Add a server" render={<Link to="/server-setup" />}>
            <span className="grid size-8 place-items-center rounded-lg border border-dashed border-sidebar-border">
              <Plus className="size-4" />
            </span>
            <span className="grid min-w-0 leading-tight">
              <span className="truncate font-medium text-sidebar-accent-foreground">Add a server</span>
              <span className="truncate text-xs">Most pages need one</span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  const switchTo = async (id: string, name: string) => {
    try {
      await selectServer(id)
    } catch {
      toastManager.add({ title: 'Switch failed', description: `Could not select ${name}.`, type: 'error' })
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Menu>
          <MenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={selectedServer ? `${selectedServer.name}: ${state.label}` : 'Select a server'}
                className="border border-sidebar-border bg-background shadow-xs/5 data-popup-open:bg-sidebar-accent dark:bg-input/32"
              />
            }
          >
            <span className="grid size-8 shrink-0 place-items-center">
              <span className={cn('size-2 rounded-full', state.dot)} aria-hidden />
            </span>
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate font-medium text-sidebar-accent-foreground">
                {selectedServer?.name ?? 'Select a server'}
              </span>
              <span className="truncate text-xs">
                {state.label}
                {runState === 'running' && playerCount > 0 ? ` · ${playerCount} online` : ''}
              </span>
            </span>
            <ChevronsUpDown className="ms-auto size-4 opacity-60" />
          </MenuTrigger>
          <MenuPopup align="start" className="w-(--anchor-width) min-w-56">
            <MenuGroup>
              <MenuGroupLabel>Servers</MenuGroupLabel>
              {servers.map((server) => (
                <MenuItem key={server.id} onClick={() => void switchTo(String(server.id), server.name)}>
                  <Server />
                  <span className="flex-1 truncate">{server.name}</span>
                  {server.isActive && <Check className="opacity-80" />}
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuItem onClick={() => void navigate({ to: '/servers' })}>Manage servers</MenuItem>
            <MenuItem onClick={() => void navigate({ to: '/server-setup' })}>
              <Plus />
              Add a server
            </MenuItem>
          </MenuPopup>
        </Menu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function NavSignal({ item, status }: { item: NavItem; status: ShellStatus }) {
  if (item.to === '/players' && status.runState === 'running' && status.playerCount > 0) {
    return <SidebarMenuBadge>{countLabel(status.playerCount)}</SidebarMenuBadge>
  }
  if (item.to === '/mods' && status.modUpdates > 0) {
    return (
      <SidebarMenuBadge
        className="bg-warning/12 text-warning-foreground dark:bg-warning/18"
        title={`${status.modUpdates} mod update${status.modUpdates === 1 ? '' : 's'} available`}
      >
        {countLabel(status.modUpdates)}
      </SidebarMenuBadge>
    )
  }
  if (item.to === '/servers' && status.servers && status.servers.length > 1) {
    return <SidebarMenuBadge>{status.servers.length}</SidebarMenuBadge>
  }
  if (item.to === '/settings' && status.panelUpdate) {
    return (
      <SidebarMenuBadge
        className="bg-warning/12 text-warning-foreground dark:bg-warning/18"
        title={status.panelUpdate.version ? `Panel update available: v${status.panelUpdate.version}` : 'Panel update available'}
      >
        1
      </SidebarMenuBadge>
    )
  }
  return null
}

function UserMenu({ panelVersion, onShowShortcuts }: { panelVersion: string; onShowShortcuts: () => void }) {
  const { user, authEnabled, logout } = useAuth()
  const name = authEnabled && user ? user.username : 'Better ZCP'

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Menu>
          <MenuTrigger
            data-action="user-menu"
            render={<SidebarMenuButton size="lg" tooltip={name} className="data-popup-open:bg-sidebar-accent" />}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground uppercase">
              {name.slice(0, 1)}
            </span>
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate font-medium text-sidebar-accent-foreground">{name}</span>
              <span className="truncate font-mono text-xs">v{panelVersion || '—'}</span>
            </span>
            <ChevronsUpDown className="ms-auto size-4 opacity-60" />
          </MenuTrigger>
          <MenuPopup align="start" side="top" className="w-(--anchor-width) min-w-56">
            <MenuItem onClick={onShowShortcuts}>
              <Keyboard />
              Keyboard shortcuts
            </MenuItem>
            <MenuItem render={<a href="https://github.com/itsmeares/better-zcp" target="_blank" rel="noopener noreferrer" />}>
              <Github />
              GitHub repository
            </MenuItem>
            {authEnabled && user && (
              <>
                <MenuSeparator />
                <MenuItem data-action="sign-out" onClick={logout}>
                  <LogOut />
                  Sign out
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function AppSidebar({ status, onShowShortcuts }: { status: ShellStatus; onShowShortcuts: () => void }) {
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()

  useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  return (
    <Sidebar variant="inset" collapsible="icon" aria-label="Sidebar">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <img src={`${import.meta.env.BASE_URL}spiffo.png`} alt="" width={24} height={24} className="size-6 shrink-0 object-contain" />
          <span className="truncate text-sm font-semibold text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden">
            Better ZCP
          </span>
        </div>
        <ServerSwitcher status={status} />
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label="Main navigation">
          {NAV_GROUPS.map((group, index) => (
            <SidebarGroup key={group.label ?? index} className={cn(!group.label && 'pb-0')}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const blocked = item.requiresServer && status.serversConfirmedEmpty
                    return (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton
                          isActive={pathname === item.to}
                          tooltip={blocked ? NO_SERVER_REASON : item.label}
                          aria-disabled={blocked || undefined}
                          title={blocked ? NO_SERVER_REASON : undefined}
                          render={<Link to={item.to} disabled={blocked} />}
                        >
                          <NavTile item={item} className="-ms-1 group-data-[collapsible=icon]:-m-1" />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                        <NavSignal item={item} status={status} />
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>

      <SidebarFooter>
        <ConnectionStatus />
        <UserMenu panelVersion={status.panelVersion} onShowShortcuts={onShowShortcuts} />
      </SidebarFooter>
    </Sidebar>
  )
}
