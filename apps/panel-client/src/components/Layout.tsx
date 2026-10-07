import { useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronRight, RefreshCw, Search } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { AppSidebar } from './shell/AppSidebar'
import { CommandPalette } from './shell/CommandPalette'
import { ThemeMenu } from './shell/ThemeMenu'
import { findNavItem } from './shell/nav'
import { ShellStatusContext, useShellStatus, type ShellStatus } from './shell/useShellStatus'
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp'
import { MaintenanceNotice } from './MaintenanceNotice'
import { SystemHealthBanner } from './SystemHealthBanner'

const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed'

function GameUpdateBanner({ status }: { status: ShellStatus }) {
  const navigate = useNavigate()
  const update = status.gameUpdate
  if (!update) return null
  return (
    <Alert variant="warning" role="status">
      <RefreshCw aria-hidden />
      <AlertTitle>
        Game update available: build {update.installed.buildId} → {update.latest.buildId}
      </AlertTitle>
      <AlertDescription>
        New build on the {update.installed.branch} branch.
        {update.latest.description ? ` ${update.latest.description}` : ''}
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="ghost" onClick={status.dismissGameUpdate}>
          Dismiss
        </Button>
        <Button size="xs" variant="outline" onClick={() => void navigate({ to: '/servers' })}>
          Update server
        </Button>
      </AlertAction>
    </Alert>
  )
}

function TopBar({ status, onOpenPalette }: { status: ShellStatus; onOpenPalette: () => void }) {
  const { pathname } = useLocation()
  const item = findNavItem(pathname)
  const serverName = item?.requiresServer ? status.selectedServer?.name : undefined

  return (
    <header className="sticky top-0 z-10 flex h-13 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur-sm md:rounded-t-xl">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-1 h-4" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        {serverName && (
          <>
            <span className="truncate text-muted-foreground max-sm:hidden">{serverName}</span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground max-sm:hidden" aria-hidden />
          </>
        )}
        <span className="truncate font-medium">{item?.label ?? ''}</span>
      </nav>
      <div className="ms-auto flex items-center gap-1">
        <Button variant="outline" className="w-64 justify-start font-normal text-muted-foreground max-md:hidden" onClick={onOpenPalette}>
          <Search aria-hidden />
          Search or run a command
          <KbdGroup className="ms-auto">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Button>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Search or run a command" onClick={onOpenPalette}>
          <Search />
        </Button>
        <ThemeMenu />
      </div>
    </header>
  )
}

export default function Layout({ children }: { children: ReactNode }) {
  const status = useShellStatus()
  const { helpOpen, setHelpOpen } = useKeyboardShortcuts()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== 'true')

  const onSidebarOpenChange = (open: boolean) => {
    setSidebarOpen(open)
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(!open))
  }

  return (
    <ShellStatusContext.Provider value={status}>
    <SidebarProvider open={sidebarOpen} onOpenChange={onSidebarOpenChange} data-app-shell>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-60 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <AppSidebar status={status} onShowShortcuts={() => setHelpOpen(true)} />
      <SidebarInset className="min-w-0">
        <TopBar status={status} onOpenPalette={() => setPaletteOpen(true)} />
        <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
          <div className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-5 md:px-6 lg:px-8 lg:py-6">
            <SystemHealthBanner />
            <GameUpdateBanner status={status} />
            <MaintenanceNotice />
            <div>{children}</div>
          </div>
        </main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} status={status} onShowShortcuts={() => setHelpOpen(true)} />
      <KeyboardShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </SidebarProvider>
    </ShellStatusContext.Provider>
  )
}
