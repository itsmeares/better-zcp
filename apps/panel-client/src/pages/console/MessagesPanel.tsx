import { useState } from 'react'
import { ChevronDown, Send } from 'lucide-react'
import { useShell } from '@/components/shell/useShellStatus'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { toastManager } from '@/components/ui/toast'
import type { RconLink } from './useRconLink'

const TAGS = [
  { value: 'all', label: 'No tag' },
  { value: 'admin', label: '[ADMIN]' },
  { value: 'say', label: '[SAY]' },
  { value: 'faction', label: '[FACTION]' },
  { value: 'safehouse', label: '[SAFEHOUSE]' },
]

/** Message templates. They only fill the box; a restart warning here does not restart anything. */
const PRESETS = [
  { label: 'Restart warning, 15 min', message: 'SERVER RESTART in 15 minutes - Please find a safe location!' },
  { label: 'Restart warning, 5 min', message: 'SERVER RESTART in 5 minutes - Save your progress!' },
  { label: 'Restart warning, 1 min', message: 'SERVER RESTART in 1 minute - Disconnecting soon!' },
  { label: 'Maintenance starting', message: 'Server entering MAINTENANCE MODE - Please save and disconnect' },
  { label: 'Maintenance done', message: 'Maintenance complete - Server is back online!' },
  { label: 'Save warning', message: 'Server will save in 30 seconds - Brief lag expected' },
  { label: 'Welcome', message: 'Welcome! Please read the rules at spawn' },
]

/** servermsg needs a quoted string, so quotes, backslashes and control characters can't go through. */
function cleanMessage(text: string) {
  return Array.from(text.replace(/["\\]/g, ''))
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
}

export function MessagesPanel({ link }: { link: RconLink }) {
  const { playerCount } = useShell()
  const [tag, setTag] = useState('all')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const usable = link.configured && link.connected !== false

  const send = async () => {
    const text = cleanMessage(message.trim())
    if (!text) return
    setSending(true)
    const result = await link.execute(tag === 'all' ? `servermsg "${text}"` : `servermsg "[${tag.toUpperCase()}] ${text}"`)
    setSending(false)
    if (result.success) {
      toastManager.add({ title: 'Message sent', description: text, type: 'success' })
      setMessage('')
    } else {
      toastManager.add({ title: 'Message not sent', description: result.error || 'The server rejected it.', type: 'error' })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Message everyone online</CardTitle>
        <CardDescription>
          Shows in every player's chat{playerCount > 0 ? `. ${playerCount} online now.` : '.'}
        </CardDescription>
      </CardHeader>
      <CardPanel className="grid gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <Field className="w-44">
            <FieldLabel>Tag</FieldLabel>
            <Select items={TAGS} value={tag} onValueChange={(value) => setTag(String(value))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {TAGS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Menu>
            <MenuTrigger render={<Button variant="outline" disabled={!usable} />}>
              Use a template
              <ChevronDown />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuGroup>
                <MenuGroupLabel>Fills the message. Nothing else happens.</MenuGroupLabel>
                {PRESETS.map((preset) => (
                  <MenuItem key={preset.label} onClick={() => setMessage(preset.message)}>
                    {preset.label}
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        </div>
        <Field>
          <FieldLabel>Message</FieldLabel>
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void send()
            }}
            placeholder="What players should see"
            maxLength={500}
            disabled={sending || !usable}
          />
        </Field>
      </CardPanel>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Tags only change the text. RCON can't post to a real chat channel.</p>
        <Button onClick={() => void send()} disabled={sending || !message.trim() || !usable}>
          {sending ? <Spinner /> : <Send />}
          Send message
        </Button>
      </CardFooter>
    </Card>
  )
}
