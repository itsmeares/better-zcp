import { Link } from '@tanstack/react-router'
import {
  Archive,
  CalendarClock,
  ChevronDown,
  Copy,
  Gamepad2,
  Loader2,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Skull,
  Square,
  Wifi,
  Zap,
} from 'lucide-react'
import { copyText, formatUptime } from '@/lib/utils'
import { DisabledReason } from '@/components/DisabledReason'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Group, GroupSeparator } from '@/components/ui/group'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { toastManager } from '@/components/ui/toast'
import { RESTART_DELAYS, type ServerActions } from '@/components/server/useServerActions'
import type { ServerRunState } from '@/components/shell/useShellStatus'

const RUN_BADGE: Record<ServerRunState, { label: string; variant: 'success' | 'secondary' | 'warning' | 'outline' }> = {
  running: { label: 'Running', variant: 'success' },
  stopped: { label: 'Stopped', variant: 'secondary' },
  transitioning: { label: 'Starting or stopping', variant: 'warning' },
  unknown: { label: 'Status unknown', variant: 'outline' },
}

export interface HeaderFacts {
  name: string
  runState: ServerRunState
  rconConnected: boolean
  uptime: number | null
  map: string | null
  lanAddress: string | null
  publicAddress: string | null
  panelAddress: { label: string; url: string } | null
  nextRun: { label: string; eta: string } | null
  lastBackup: string | null
}

async function copy(text: string, what: string) {
  try {
    await copyText(text)
    toastManager.add({ title: `${what} copied`, description: text, type: 'success', timeout: 2000 })
  } catch {
    toastManager.add({ title: 'Could not copy', description: 'Your browser blocked clipboard access.', type: 'error' })
  }
}

function CopyChip({ label, value, what }: { label: string; value: string; what: string }) {
  return (
    <Badge variant="outline" render={<button type="button" onClick={() => void copy(value, what)} title={`Copy ${what.toLowerCase()}`} />}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
      <Copy />
    </Badge>
  )
}

export function OverviewHeader({ facts, actions, onRefresh }: { facts: HeaderFacts; actions: ServerActions; onRefresh: () => void }) {
  const { run, busy } = actions
  const { runState, rconConnected } = facts
  const online = runState === 'running' || runState === 'transitioning'
  const badge = RUN_BADGE[runState]
  const spinner = (kind: string) => (busy === kind ? <Loader2 className="animate-spin" /> : null)

  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="grid min-w-0 flex-1 basis-80 gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{facts.name}</h1>
          <Badge variant={badge.variant} size="lg">
            {badge.label}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          {facts.lanAddress && <CopyChip label="LAN" value={facts.lanAddress} what="LAN address" />}
          {facts.publicAddress && <CopyChip label="Public" value={facts.publicAddress} what="Public address" />}
          {facts.panelAddress && <CopyChip label="Panel" value={facts.panelAddress.label} what="Panel address" />}
          {facts.publicAddress && (
            <Badge variant="outline" render={<a href={`steam://connect/${facts.publicAddress}`} title="Join through Steam" />}>
              <Gamepad2 />
              Join
            </Badge>
          )}
          {online && facts.uptime ? <span className="ms-1">Up {formatUptime(facts.uptime)}</span> : null}
          {facts.map && <span className="ms-1" title="Map, from live game data">{facts.map}</span>}
          {facts.nextRun && (
            <Badge variant="outline" render={<Link to="/schedule" />}>
              <CalendarClock />
              Next: {facts.nextRun.label} {facts.nextRun.eta}
            </Badge>
          )}
          {facts.lastBackup && (
            <Badge variant="outline" render={<Link to="/backups" />}>
              <Archive />
              {facts.lastBackup}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {online ? (
          <>
            <Group>
              <Button variant="outline" onClick={() => void run({ kind: 'restart', minutes: 5 })} disabled={busy !== null}>
                {spinner('restart') ?? <RotateCcw />}
                Restart
              </Button>
              <GroupSeparator />
              <Menu>
                <MenuTrigger render={<Button variant="outline" size="icon" aria-label="More restart options" disabled={busy !== null} />}>
                  <ChevronDown />
                </MenuTrigger>
                <MenuPopup align="end">
                  {RESTART_DELAYS.map((minutes) => (
                    <MenuItem key={minutes} onClick={() => void run({ kind: 'restart', minutes })}>
                      Restart in {minutes} min
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={() => void run({ kind: 'restart', minutes: 0 })}>
                    <Zap />
                    Restart now
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </Group>
            <Button variant="outline" onClick={() => void run({ kind: 'stop' })} disabled={busy !== null}>
              {spinner('stop') ?? <Square />}
              Stop
            </Button>
            <DisabledReason reason={rconConnected ? null : 'Saving needs RCON. Connect it from the menu.'}>
              <Button variant="outline" onClick={() => void run({ kind: 'save' })} disabled={busy !== null || !rconConnected}>
                {spinner('save') ?? <Save />}
                Save
              </Button>
            </DisabledReason>
          </>
        ) : (
          <DisabledReason reason={runState === 'unknown' ? "The panel can't tell whether the server is already running." : null}>
            <Button onClick={() => void run({ kind: 'start' })} disabled={busy !== null || runState === 'unknown'}>
              {spinner('start') ?? <Play />}
              Start
            </Button>
          </DisabledReason>
        )}
        <Menu>
          <MenuTrigger render={<Button variant="outline" size="icon" aria-label="More server actions" />}>
            <MoreHorizontal />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void run({ kind: 'backup' })} disabled={busy !== null}>
              <Archive />
              Create backup
            </MenuItem>
            {online && !rconConnected && (
              <MenuItem onClick={() => void run({ kind: 'connect-rcon' })} disabled={busy !== null}>
                <Wifi />
                Connect RCON
              </MenuItem>
            )}
            <MenuItem onClick={onRefresh}>
              <RefreshCw />
              Refresh status
            </MenuItem>
            <MenuItem render={<Link to="/server-settings" />}>
              <Settings2 />
              Server settings
            </MenuItem>
            {online && (
              <>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => void run({ kind: 'force-stop' })} disabled={busy !== null}>
                  <Skull />
                  Force stop
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      </div>
    </header>
  )
}
