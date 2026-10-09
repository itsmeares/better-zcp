import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Ban, Eye, Ghost, Heart, Layers, MapPin, MoreHorizontal, Shield, Skull, UserX } from 'lucide-react'
import { gameIntegrationApi, playersApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useConfirm } from '@/contexts/ConfirmContext'
import { HelpTip } from '@/components/HelpTip'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger } from '@/components/ui/menu'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { toastManager } from '@/components/ui/toast'

export interface PlayerPowers {
  godMode?: boolean
  invisible?: boolean
  noclip?: boolean
}

const TELEPORT_PRESETS = [
  { name: 'Muldraugh', x: 10500, y: 9700 },
  { name: 'West Point', x: 11800, y: 6900 },
  { name: 'Riverside', x: 6500, y: 5300 },
  { name: 'Rosewood', x: 8000, y: 11300 },
  { name: 'Louisville', x: 12500, y: 3500 },
  { name: 'March Ridge', x: 9900, y: 12800 },
  { name: 'Ekron', x: 4500, y: 9000 },
  { name: 'Military Base', x: 10300, y: 12900 },
]

const ACCESS_LABELS: Record<string, string> = {
  admin: 'Admin',
  moderator: 'Moderator',
  gm: 'GM',
  observer: 'Observer',
  user: 'User (demote, try this first)',
  none: 'None (the official demote value)',
}

const POWERS = [
  { key: 'godMode', label: 'God mode', icon: Ghost, api: playersApi.setGodMode },
  { key: 'invisible', label: 'Invisible', icon: Eye, api: playersApi.setInvisible },
  { key: 'noclip', label: 'Noclip', icon: Layers, api: playersApi.setNoclip },
] as const

/** Runs one player action with a busy flag and the same success and error toasts everywhere. */
export function usePlayerAction(onDone?: () => void) {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, success: string, action: () => Promise<unknown>) => {
    setBusy(key)
    try {
      const result = await action()
      if (result && typeof result === 'object' && (result as { success?: boolean }).success === false) {
        throw new Error((result as { error?: string }).error || 'The server refused.')
      }
      toastManager.add({ title: success, type: 'success' })
      onDone?.()
      return true
    } catch (error) {
      toastManager.add({ title: 'That didn’t work', description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
      return false
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

type DialogKind = 'kick' | 'ban' | 'teleport' | 'access' | null

/**
 * Every action on one player: kick, ban, teleport, access level, heal, powers and kill.
 * Players shows Kick and Ban as buttons; the map puts everything in one menu.
 */
export function PlayerActions({
  player,
  powers,
  integrationConnected,
  onChanged,
  inline = true,
  extraItems,
}: {
  player: string
  powers?: PlayerPowers
  integrationConnected: boolean
  onChanged?: () => void
  inline?: boolean
  extraItems?: ReactNode
}) {
  const confirm = useConfirm()
  const { busy, run } = usePlayerAction(onChanged)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [reason, setReason] = useState('')
  const [banIp, setBanIp] = useState(false)
  const [target, setTarget] = useState({ who: '', x: '', y: '', z: '0' })
  const [level, setLevel] = useState('')
  const { data: levels = [] } = useQuery({
    queryKey: ['players', 'access-levels'],
    queryFn: async () => ((await playersApi.getAccessLevels()) as { levels?: string[] }).levels ?? [],
    enabled: dialog === 'access',
    staleTime: Infinity,
  })

  const open = (kind: DialogKind) => {
    setReason('')
    setBanIp(false)
    setLevel('')
    setTarget({ who: player, x: '', y: '', z: '0' })
    setDialog(kind)
  }
  const close = () => setDialog(null)
  const needsIntegration = integrationConnected ? null : 'Needs the game integration'

  const kick = async () => {
    if (await run('kick', `Kicked ${player}`, () => playersApi.kick(player, reason))) close()
  }
  const ban = async () => {
    const confirmed = await confirm({
      title: `Ban ${player}?`,
      description: `${player} can't join again until you unban them${banIp ? ', and nobody can join from their IP address' : ''}.${reason ? ` Reason: ${reason}` : ''}`,
      confirmLabel: 'Ban player',
      destructive: true,
    })
    if (confirmed && (await run('ban', `Banned ${player}`, () => playersApi.ban(player, banIp, reason)))) close()
  }
  const teleport = async () => {
    const who = target.who.trim() || player
    const point = { x: Number(target.x), y: Number(target.y), z: Number(target.z || '0') }
    if (await run('teleport', `Teleported ${who}`, () => playersApi.teleport(who, point))) close()
  }
  const setAccess = async () => {
    if (await run('access', `${player} is now ${ACCESS_LABELS[level]?.split(' ')[0] ?? level}`, () => playersApi.setAccessLevel(player, level))) close()
  }
  const kill = async () => {
    const confirmed = await confirm({
      title: `Kill ${player}?`,
      description: `This ends ${player}'s character right away. On a permadeath server there is no undo, no respawn as the same character and no restore.`,
      confirmLabel: 'Kill player',
      destructive: true,
      requireTypedConfirmation: { value: player, label: `Type ${player} to confirm` },
    })
    if (confirmed) await run('kill', `Killed ${player}`, () => gameIntegrationApi.killPlayer(player))
  }
  const togglePower = (power: (typeof POWERS)[number], enabled: boolean) =>
    run(power.key, `${power.label} ${enabled ? 'on' : 'off'} for ${player}`, () => power.api(player, enabled))

  const items = (
    <>
      {!inline && (
        <>
          <MenuItem onClick={() => open('kick')}>
            <UserX />
            Kick…
          </MenuItem>
          <MenuItem onClick={() => open('ban')}>
            <Ban />
            Ban…
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuItem onClick={() => open('teleport')}>
        <MapPin />
        Teleport…
      </MenuItem>
      <MenuItem onClick={() => open('access')}>
        <Shield />
        Access level…
      </MenuItem>
      <MenuItem disabled={!!needsIntegration || busy !== null} onClick={() => void run('heal', `Healed ${player}`, () => gameIntegrationApi.healPlayer(player))}>
        <Heart />
        Heal{needsIntegration && <span className="ms-auto text-xs text-muted-foreground">{needsIntegration}</span>}
      </MenuItem>
      <MenuSeparator />
      {POWERS.map((power) => {
        const state = powers?.[power.key]
        const Icon = power.icon
        // Without live data the panel can't know the current state, so it offers both directions.
        return state === undefined ? (
          <MenuSub key={power.key}>
            <MenuSubTrigger disabled={busy !== null}>
              <Icon />
              {power.label}
              <span className="ms-auto text-xs text-muted-foreground">Unknown</span>
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuItem onClick={() => void togglePower(power, true)}>Turn on</MenuItem>
              <MenuItem onClick={() => void togglePower(power, false)}>Turn off</MenuItem>
            </MenuSubPopup>
          </MenuSub>
        ) : (
          <MenuCheckboxItem key={power.key} checked={state} disabled={busy !== null} onCheckedChange={(checked) => void togglePower(power, checked)}>
            {power.label}
          </MenuCheckboxItem>
        )
      })}
      {extraItems}
      <MenuSeparator />
      <MenuItem variant="destructive" disabled={!!needsIntegration || busy !== null} onClick={() => void kill()}>
        <Skull />
        Kill…
      </MenuItem>
    </>
  )

  return (
    <>
      <div className="flex items-center gap-1.5">
        {inline && (
          <>
            <Button variant="outline" size="sm" onClick={() => open('kick')}>
              <UserX />
              Kick
            </Button>
            <Button variant="outline" size="sm" onClick={() => open('ban')} className="text-destructive-foreground">
              <Ban />
              Ban
            </Button>
          </>
        )}
        <Menu>
          <MenuTrigger
            render={
              inline ? (
                <Button variant="outline" size="icon-sm" aria-label={`More actions for ${player}`} />
              ) : (
                <Button variant="secondary" size="sm" className="w-full" />
              )
            }
          >
            {inline ? (
              <MoreHorizontal />
            ) : (
              <>
                Actions
                <MoreHorizontal className="ms-auto" />
              </>
            )}
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-56">
            {items}
          </MenuPopup>
        </Menu>
      </div>

      <Dialog open={dialog !== null} onOpenChange={(next) => !next && close()}>
        <DialogPopup className="sm:max-w-md">
          {dialog === 'kick' && (
            <>
              <DialogHeader>
                <DialogTitle>Kick {player}</DialogTitle>
                <DialogDescription>They're disconnected and can join again right away.</DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Field>
                  <FieldLabel>Reason (optional)</FieldLabel>
                  <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Shown to the player" autoFocus />
                </Field>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button variant="destructive" onClick={() => void kick()} disabled={busy !== null}>
                  {busy === 'kick' && <Spinner />}
                  Kick player
                </Button>
              </DialogFooter>
            </>
          )}
          {dialog === 'ban' && (
            <>
              <DialogHeader>
                <DialogTitle>Ban {player}</DialogTitle>
                <DialogDescription>They can't join again until you unban them by name.</DialogDescription>
              </DialogHeader>
              <DialogPanel className="grid gap-4">
                <Field>
                  <FieldLabel>Reason (optional)</FieldLabel>
                  <Input value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
                </Field>
                <Label className="flex items-center gap-2">
                  <Checkbox checked={banIp} onCheckedChange={(checked) => setBanIp(checked === true)} />
                  Also ban their IP address
                  <HelpTip label="IP bans">
                    This can also block other people on the same network, and the panel can't list or lift IP bans on their own.
                  </HelpTip>
                </Label>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button variant="destructive" onClick={() => void ban()} disabled={busy !== null}>
                  {busy === 'ban' && <Spinner />}
                  Continue
                </Button>
              </DialogFooter>
            </>
          )}
          {dialog === 'teleport' && (
            <>
              <DialogHeader>
                <DialogTitle>Teleport a player</DialogTitle>
                <DialogDescription>Build 42 multiplayer doesn't always sync a teleport right away.</DialogDescription>
              </DialogHeader>
              <DialogPanel className="grid gap-4">
                <Field>
                  <FieldLabel>Player</FieldLabel>
                  <Input value={target.who} onChange={(event) => setTarget({ ...target, who: event.target.value })} />
                </Field>
                <div className="flex flex-wrap gap-1.5">
                  {TELEPORT_PRESETS.map((preset) => (
                    <Button key={preset.name} size="xs" variant="outline" onClick={() => setTarget({ ...target, x: String(preset.x), y: String(preset.y), z: '0' })}>
                      {preset.name}
                    </Button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(['x', 'y', 'z'] as const).map((axis) => (
                    <Field key={axis}>
                      <FieldLabel>
                        {axis.toUpperCase()}
                        {axis === 'z' && <HelpTip label="Z">The floor, not a height. 0 is ground level.</HelpTip>}
                      </FieldLabel>
                      <Input
                        type="number"
                        min={0}
                        max={axis === 'z' ? 8 : 24000}
                        value={target[axis]}
                        onChange={(event) => setTarget({ ...target, [axis]: event.target.value })}
                        placeholder={axis === 'z' ? '0' : axis === 'x' ? '10500' : '9700'}
                      />
                    </Field>
                  ))}
                </div>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button onClick={() => void teleport()} disabled={busy !== null || !target.x || !target.y}>
                  {busy === 'teleport' && <Spinner />}
                  Teleport
                </Button>
              </DialogFooter>
            </>
          )}
          {dialog === 'access' && (
            <>
              <DialogHeader>
                <DialogTitle>Access level for {player}</DialogTitle>
                <DialogDescription>Staff levels unlock admin commands in game.</DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Select
                  items={levels.map((value) => ({ value, label: ACCESS_LABELS[value] ?? value }))}
                  value={level || null}
                  onValueChange={(value) => setLevel(String(value ?? ''))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a level" />
                  </SelectTrigger>
                  <SelectPopup>
                    {levels.map((value) => (
                      <SelectItem key={value} value={value}>
                        {ACCESS_LABELS[value] ?? value}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button onClick={() => void setAccess()} disabled={busy !== null || !level}>
                  {busy === 'access' && <Spinner />}
                  Set level
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </>
  )
}
