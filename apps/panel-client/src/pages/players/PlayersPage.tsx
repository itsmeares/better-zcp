import { useEffect, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { Ban, ChevronDown, MicOff, RefreshCw, UserCheck, UserPlus } from 'lucide-react'
import { playersApi } from '@/lib/api'
import { useConfirm } from '@/contexts/ConfirmContext'
import { PageHeader } from '@/components/PageHeader'
import { PasswordInput } from '@/components/PasswordInput'
import { usePlayerAction } from '@/components/players/PlayerActions'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Spinner } from '@/components/ui/spinner'
import { PlayerList, type ListTab } from './PlayerList'
import { PlayerPanel } from './PlayerPanel'
import { sanitizeSteamId, usePlayersData } from './usePlayersData'

type Tool = 'account' | 'steam-ban' | 'unban' | 'voice' | null

export default function PlayersPage() {
  const { player: requested } = useSearch({ from: '/players' })
  const data = usePlayersData()
  const confirm = useConfirm()
  const { busy, run } = usePlayerAction(data.refresh)
  const [tab, setTab] = useState<ListTab>('online')
  const [selected, setSelected] = useState(requested?.trim() ?? '')
  const [tool, setTool] = useState<Tool>(null)
  const [form, setForm] = useState({ name: '', password: '', steamId: '', reason: '', mute: true })

  // A link like /players?player=Kate opens that player, matching the online name's case.
  useEffect(() => {
    if (!requested) return
    const match = data.online.find((player) => player.name.toLowerCase() === requested.trim().toLowerCase())
    setSelected(match?.name ?? requested.trim())
  }, [requested, data.online])

  const openTool = (next: Tool, name = '') => {
    setForm({ name, password: '', steamId: '', reason: '', mute: true })
    setTool(next)
  }
  const done = (ok: boolean) => ok && setTool(null)

  const addAccount = async () => done(await run('account', `Added ${form.name.trim()}`, () => playersApi.addUser(form.name.trim(), form.password)))
  const banSteamId = async () => {
    const confirmed = await confirm({
      title: `Ban Steam ID ${form.steamId}?`,
      description: 'That Steam account can’t join until you unban it from the Banned list.',
      confirmLabel: 'Ban Steam ID',
      destructive: true,
    })
    if (confirmed) done(await run('steam-ban', `Banned ${form.steamId}`, () => playersApi.banSteamId(form.steamId, form.reason.trim())))
  }
  const unban = async () => done(await run('unban', `Unbanned ${form.name.trim()}`, () => playersApi.unban(form.name.trim())))
  const voice = async () =>
    done(await run('voice', `${form.mute ? 'Muted' : 'Unmuted'} ${form.name.trim()}`, () => playersApi.voiceBan(form.name.trim(), form.mute)))

  const passwordTooShort = form.password.length > 0 && form.password.length < 4
  const loadFailed = data.stats.isError && data.bans.isError

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Players"
        description="Who's online, who has played, bans and the whitelist."
        actions={
          <>
            <Button variant="ghost" size="icon" onClick={data.refresh} aria-label="Refresh">
              <RefreshCw />
            </Button>
            <Button variant="outline" onClick={() => openTool('account')}>
              <UserPlus />
              Add account
            </Button>
            <Menu>
              <MenuTrigger render={<Button variant="outline" />}>
                More
                <ChevronDown />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => openTool('steam-ban')}>
                  <Ban />
                  Ban a Steam ID…
                </MenuItem>
                <MenuItem onClick={() => openTool('unban')}>
                  <UserCheck />
                  Unban by name…
                </MenuItem>
                <MenuItem onClick={() => openTool('voice', selected)}>
                  <MicOff />
                  Voice chat mute…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        }
      />

      {loadFailed && (
        <Alert variant="error">
          <AlertTitle>Some player data didn't load</AlertTitle>
          <AlertDescription>Playtime and bans are unavailable right now.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={data.refresh}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <PlayerList data={data} tab={tab} onTabChange={setTab} selected={selected} onSelect={setSelected} />
        <PlayerPanel player={selected.trim()} data={data} onAddAccount={(name) => openTool('account', name)} />
      </div>

      <Dialog open={tool !== null} onOpenChange={(open) => !open && setTool(null)}>
        <DialogPopup className="sm:max-w-md">
          {tool === 'account' && (
            <>
              <DialogHeader>
                <DialogTitle>Add an account</DialogTitle>
                <DialogDescription>For whitelist-only servers. The player signs in with this name and password.</DialogDescription>
              </DialogHeader>
              <DialogPanel className="grid gap-4">
                <Field>
                  <FieldLabel>Username</FieldLabel>
                  <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={64} autoFocus />
                </Field>
                <Field>
                  <FieldLabel>Password (optional)</FieldLabel>
                  <PasswordInput value={form.password} onChange={(password) => setForm({ ...form, password })} maxLength={128} />
                  <FieldDescription>{passwordTooShort ? 'Use at least 4 characters, or leave it empty.' : 'Build 42 allows an empty password.'}</FieldDescription>
                </Field>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button onClick={() => void addAccount()} disabled={busy !== null || !form.name.trim() || passwordTooShort}>
                  {busy === 'account' && <Spinner />}
                  Add account
                </Button>
              </DialogFooter>
            </>
          )}
          {tool === 'steam-ban' && (
            <>
              <DialogHeader>
                <DialogTitle>Ban a Steam ID</DialogTitle>
                <DialogDescription>Works while the player is offline.</DialogDescription>
              </DialogHeader>
              <DialogPanel className="grid gap-4">
                <Field>
                  <FieldLabel>Steam ID</FieldLabel>
                  <Input
                    value={form.steamId}
                    onChange={(event) => setForm({ ...form, steamId: sanitizeSteamId(event.target.value) })}
                    placeholder="76561198XXXXXXXXX"
                    inputMode="numeric"
                    className="font-mono"
                    autoFocus
                  />
                  <FieldDescription>17 digits.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Reason (optional)</FieldLabel>
                  <Input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
                </Field>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button variant="destructive" onClick={() => void banSteamId()} disabled={busy !== null || form.steamId.length !== 17}>
                  {busy === 'steam-ban' && <Spinner />}
                  Continue
                </Button>
              </DialogFooter>
            </>
          )}
          {tool === 'unban' && (
            <>
              <DialogHeader>
                <DialogTitle>Unban by name</DialogTitle>
                <DialogDescription>For bans made by username. Steam ID bans are in the Banned list.</DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Field>
                  <FieldLabel>Username</FieldLabel>
                  <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} autoFocus />
                </Field>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button onClick={() => void unban()} disabled={busy !== null || !form.name.trim()}>
                  {busy === 'unban' && <Spinner />}
                  Unban
                </Button>
              </DialogFooter>
            </>
          )}
          {tool === 'voice' && (
            <>
              <DialogHeader>
                <DialogTitle>Voice chat mute</DialogTitle>
                <DialogDescription>The player stays connected but can't use proximity voice.</DialogDescription>
              </DialogHeader>
              <DialogPanel className="grid gap-4">
                <Field>
                  <FieldLabel>Username</FieldLabel>
                  <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} autoFocus />
                </Field>
                <Label className="flex items-center gap-2">
                  <Checkbox checked={form.mute} onCheckedChange={(checked) => setForm({ ...form, mute: checked === true })} />
                  Mute (clear this to unmute)
                </Label>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button onClick={() => void voice()} disabled={busy !== null || !form.name.trim()}>
                  {busy === 'voice' && <Spinner />}
                  {form.mute ? 'Mute' : 'Unmute'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </div>
  )
}
