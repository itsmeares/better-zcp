import { Fragment, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Archive, Keyboard, Moon, Play, RotateCcw, Save, Server, Square, Sun, UserRound } from 'lucide-react'
import { selectServer } from '@/lib/serverSelection'
import { useTheme } from '@/contexts/ThemeContext'
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { useServerActions, type ServerAction } from '@/components/server/useServerActions'
import { NAV_ITEMS } from './nav'
import { NavTile } from './NavTile'
import type { ShellStatus } from './useShellStatus'

interface PaletteItem {
  value: string
  label: string
  icon: React.ReactNode
  shortcut?: string
  run: () => void
}

interface PaletteGroup {
  value: string
  items: PaletteItem[]
}

export function CommandPalette({
  open,
  onOpenChange,
  status,
  onShowShortcuts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: ShellStatus
  onShowShortcuts: () => void
}) {
  const navigate = useNavigate()
  const { setTheme } = useTheme()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  const { run } = useServerActions()
  const blocked = status.serversConfirmedEmpty
  const online = status.runState === 'running' || status.runState === 'transitioning'
  const serverAction = (value: string, label: string, icon: React.ReactNode, action: ServerAction): PaletteItem => ({
    value,
    label,
    icon,
    run: () => void run(action),
  })
  const serverActions: PaletteItem[] = !status.selectedServer
    ? []
    : online
      ? [
          serverAction('restart', 'Restart server in 5 minutes', <RotateCcw />, { kind: 'restart', minutes: 5 }),
          serverAction('restart-now', 'Restart server now', <RotateCcw />, { kind: 'restart', minutes: 0 }),
          serverAction('stop', 'Stop server', <Square />, { kind: 'stop' }),
          serverAction('save', 'Save world', <Save />, { kind: 'save' }),
          serverAction('backup', 'Create backup', <Archive />, { kind: 'backup' }),
        ]
      : status.runState === 'stopped'
        ? [serverAction('start', 'Start server', <Play />, { kind: 'start' }), serverAction('backup', 'Create backup', <Archive />, { kind: 'backup' })]
        : []
  const isDark = document.documentElement.classList.contains('dark')
  const groups: PaletteGroup[] = [
    {
      value: 'Pages',
      items: NAV_ITEMS.filter((item) => !(item.requiresServer && blocked)).map((item) => ({
        value: `page:${item.to}`,
        label: item.label,
        icon: <NavTile item={item} className="size-5 [&_svg]:size-3" />,
        shortcut: item.shortcut,
        run: () => void navigate({ to: item.to }),
      })),
    },
    { value: 'Server', items: serverActions },
    {
      value: 'Online players',
      items: (online ? status.players : []).map((player) => ({
        value: `player:${player.name}`,
        label: player.name,
        icon: <UserRound />,
        run: () => void navigate({ to: '/players', search: { player: player.name } }),
      })),
    },
    {
      value: 'Switch server',
      items: (status.servers ?? [])
        .filter((server) => !server.isActive)
        .map((server) => ({
          value: `server:${server.id}`,
          label: server.name,
          icon: <Server />,
          run: () => void selectServer(String(server.id)),
        })),
    },
    {
      value: 'Panel',
      items: [
        {
          value: 'theme',
          label: isDark ? 'Switch to light theme' : 'Switch to dark theme',
          icon: isDark ? <Sun /> : <Moon />,
          run: () => setTheme(isDark ? 'light' : 'dark'),
        },
        { value: 'shortcuts', label: 'Keyboard shortcuts', icon: <Keyboard />, shortcut: '?', run: onShowShortcuts },
      ],
    },
  ].filter((group) => group.items.length > 0)

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup>
        <Command items={groups}>
          <CommandInput placeholder="Go to a page, find a player or run a command" />
          <CommandPanel>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandList>
              {(group: PaletteGroup) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: PaletteItem) => (
                        <CommandItem
                          key={item.value}
                          value={item.label}
                          onClick={() => {
                            onOpenChange(false)
                            item.run()
                          }}
                        >
                          {item.icon}
                          <span className="flex-1">{item.label}</span>
                          {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                  <CommandSeparator />
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-2">
              <Kbd>↵</Kbd>
              <span>Open</span>
            </div>
            <div className="flex items-center gap-2">
              <Kbd>Esc</Kbd>
              <span>Close</span>
            </div>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  )
}
