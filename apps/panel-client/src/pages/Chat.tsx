import { useState, useEffect, useCallback, useRef } from 'react'
import {
  MessagesSquare,
  Send,
  Users,
  Megaphone,
  Loader2,
  RefreshCw,
  Shield,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  Check,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useAuth } from '@/contexts/AuthContext'
import { DisabledReason } from '@/components/DisabledReason'
import { EmptyState } from '@/components/EmptyState'
import { HelpTip } from '@/components/HelpTip'
import { cn } from '@/lib/utils'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'

interface ChatMessage {
  id: string
  type: string
  author?: string
  message: string
  timestamp: Date
}

interface Player {
  name: string
}

type ChatChannel = 'server' | 'admin' | 'general'

export default function Chat() {
  const defaultPresets = [
    'Server will restart in 5 minutes!',
    'Welcome to the server!',
    'Please read the rules at /rules',
    'Server maintenance starting soon',
    'Have fun and stay safe!',
  ] as string[]
  const [message, setMessage] = useState('')
  const [players, setPlayers] = useState<Player[]>([])
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [channel, setChannel] = useState<ChatChannel>('server')
  const [presets, setPresets] = useState<string[]>(defaultPresets)
  const [presetsEditing, setPresetsEditing] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const [newPresetDraft, setNewPresetDraft] = useState('')

  const chatEndRef = useRef<HTMLDivElement>(null)
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const messageInputRef = useRef<HTMLInputElement>(null)
  const stickToBottomRef = useRef(true)
  const sendingRef = useRef(false)
  const { toast } = useToast()
  const confirm = useConfirm()
  const socket = useSocket()
  const { can } = useAuth()
  const canSendServerChat = can('server.world_events')
  const canSendTargetedChat = can('players.endanger_or_impersonate')
  const canSendChat =
    channel === 'server' ? canSendServerChat : canSendTargetedChat
  const canManagePresets = can('panel.settings')

  const [nativeChatAvailable, setNativeChatAvailable] = useState<
    boolean | null
  >(null)
  useEffect(() => {
    if (!canSendServerChat) return
    let active = true
    panelBridgeApi
      .getChatInfo()
      .then((res) => {
        if (active && res.success && res.data)
          setNativeChatAvailable(res.data.chatServerAvailable)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [canSendServerChat])

  const handleScroll = useCallback(() => {
    const el = scrollViewportRef.current
    if (!el) return
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight)
    stickToBottomRef.current = distance < 80
  }, [])

  useEffect(() => {
    const root = chatEndRef.current?.closest(
      '[data-radix-scroll-area-viewport]',
    ) as HTMLDivElement | null
    scrollViewportRef.current = root
    if (!root) return
    root.addEventListener('scroll', handleScroll, { passive: true })
    return () => root.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  useEffect(() => {
    if (stickToBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [chatHistory])

  const fetchPlayers = useCallback(async () => {
    try {
      const data = await playersApi.getPlayers()
      if (data.players) {
        setPlayers(data.players)
      }
    } catch (error) {
      reportClientError('Failed to fetch players.', error)
    }
  }, [])

  useEffect(() => {
    fetchPlayers()
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      fetchPlayers()
    }, 15000)
    return () => clearInterval(interval)
  }, [fetchPlayers])

  useEffect(() => {
    if (!socket) return
    socket.on('activeServerChanged', fetchPlayers)
    return () => {
      socket.off('activeServerChanged', fetchPlayers)
    }
  }, [socket, fetchPlayers])

  useEffect(() => {
    if (socket) {
      const handleSocketMessage = (data: {
        id?: string
        type?: string
        author?: string
        message?: string
        timestamp?: string
      }) => {
        const msg = data.message
        if (!msg) return
        setChatHistory((prev) => {
          const parsedTs = data.timestamp
            ? Date.parse(data.timestamp)
            : Number.NaN
          const incomingTs = Number.isFinite(parsedTs) ? parsedTs : Date.now()
          const recent = prev.slice(-20)
          const hasSameSocketId = data.id
            ? recent.some((m) => m.id === data.id)
            : false
          const bracketedServerEcho =
            data.type === 'server' || !data.type
              ? msg.match(/^\[([^\]]+)\]\s+(.+)$/)
              : null
          const isOptimisticEcho = recent.some(
            (m) =>
              m.id.startsWith('local-') &&
              Math.abs(m.timestamp.getTime() - incomingTs) < 15000 &&
              ((m.message === msg &&
                m.author?.toLowerCase() === data.author?.toLowerCase()) ||
                (bracketedServerEcho !== null &&
                  m.message === bracketedServerEcho[2] &&
                  m.author?.toLowerCase() ===
                    bracketedServerEcho[1].toLowerCase())),
          )
          if (hasSameSocketId || isOptimisticEcho) return prev

          const newMessage: ChatMessage = {
            id:
              data.id ||
              `${incomingTs}-${Math.random().toString(36).slice(2, 8)}`,
            type: data.type || 'general',
            author: data.author,
            message: msg,
            timestamp: new Date(incomingTs),
          }

          return [...prev, newMessage].slice(-200)
        })
      }

      socket.on('chat:message', handleSocketMessage)
      return () => {
        socket.off('chat:message', handleSocketMessage)
      }
    }
  }, [socket])

  const sendMessage = async () => {
    if (!message.trim() || sendingRef.current || !canSendChat) return
    sendingRef.current = true
    setSending(true)
    try {
      let localType: ChatMessage['type'] = 'server'
      let localAuthor = 'Server'
      if (channel === 'admin') {
        await panelBridgeApi.sendToAdminChat(message)
        localType = 'admin'
        localAuthor = 'Admin'
      } else if (channel === 'general') {
        await panelBridgeApi.sendToGeneralChat(message, 'Admin')
        localType = 'general'
        localAuthor = 'Admin'
      } else {
        await panelBridgeApi.sendToServerChat(message, false)
      }

      const sentAt = new Date()
      setChatHistory((prev) =>
        [
          ...prev,
          {
            id: `local-${sentAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
            type: localType,
            author: localAuthor,
            message: message,
            timestamp: sentAt,
          },
        ].slice(-200),
      )
      stickToBottomRef.current = true
      setMessage('')
      toast({
        title:
          channel === 'admin'
            ? 'Admin Message Sent'
            : channel === 'general'
              ? 'Posted to Chat'
              : 'Broadcast Sent',
        description:
          channel === 'admin'
            ? 'Visible only to admins in-game.'
            : channel === 'general'
              ? 'Posted into the public chat stream.'
              : 'Message delivered to all connected players.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: getUserErrorMessage(error, 'Failed to send message'),
        variant: 'destructive',
      })
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    configApi
      .getAppSettings()
      .then((settings: any) => {
        if (cancelled) return
        const saved = settings?.chatPresets
        if (
          Array.isArray(saved) &&
          saved.every((p: unknown) => typeof p === 'string')
        ) {
          setPresets(saved.length > 0 ? saved : defaultPresets)
        }
      })
      .catch(() => {
        /* fall back to defaults silently */
      })
    return () => {
      cancelled = true
    }
  }, [defaultPresets])

  const persistPresets = useCallback(
    async (next: string[]) => {
      if (!canManagePresets) return
      let previous: string[] = []
      setPresets((prev) => {
        previous = prev
        return next
      })
      try {
        await configApi.updateAppSettings({ chatPresets: next })
      } catch (error) {
        setPresets(previous)
        reportClientError('Failed to save chat presets.', error)
        toast({
          title: 'Could not save presets',
          description: getUserErrorMessage(error, 'Unknown error'),
          variant: 'destructive',
        })
      }
    },
    [toast, canManagePresets],
  )

  const handleAddPreset = useCallback(() => {
    const trimmed = newPresetDraft.trim()
    if (!trimmed) return
    if (trimmed.length > 500) return
    persistPresets([...presets, trimmed])
    setNewPresetDraft('')
  }, [newPresetDraft, persistPresets, presets])

  const handleSaveEdit = useCallback(() => {
    if (editingIdx === null) return
    const trimmed = editingDraft.trim()
    if (!trimmed) return
    const next = presets.slice()
    next[editingIdx] = trimmed.slice(0, 500)
    persistPresets(next)
    setEditingIdx(null)
    setEditingDraft('')
  }, [editingDraft, editingIdx, persistPresets, presets])

  const handleDeletePreset = useCallback(
    async (idx: number) => {
      const ok = await confirm({
        title: 'Delete this preset?',
        description:
          '"' +
          String(presets[idx]) +
          '" is shared -- every admin who uses quick broadcasts loses it too. You can always re-add it.',
        confirmLabel: 'Delete Preset',
        variant: 'warning',
      })
      if (!ok) return
      const next = presets.filter((_, i) => i !== idx)
      persistPresets(next)
      if (editingIdx === idx) {
        setEditingIdx(null)
        setEditingDraft('')
      }
    },
    [confirm, editingIdx, persistPresets, presets],
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const getMessageStyle = (type: string) => {
    if (type === 'server')
      return 'border-s-2 border-amber-400/70 bg-amber-400/5 ps-3 pe-3 py-2'
    if (type === 'admin')
      return 'border-s-2 border-destructive/70 bg-destructive/5 ps-3 pe-3 py-2'
    return 'border-s-2 border-primary/55 bg-muted/15 ps-3 pe-3 py-2'
  }

  const getMessageMeta = (msg: ChatMessage) => {
    if (msg.type === 'server')
      return {
        icon: <Megaphone className="w-3 h-3" />,
        label: msg.author || 'Server',
        labelClass: 'text-amber-400',
        dotClass: 'bg-amber-400/80',
      }
    if (msg.type === 'admin')
      return {
        icon: <Shield className="w-3 h-3" />,
        label: msg.author || 'Admin',
        labelClass: 'text-destructive',
        dotClass: 'bg-destructive/80',
      }
    return {
      icon: <MessageSquare className="w-3 h-3" />,
      label: msg.author || 'Player',
      labelClass: 'text-primary',
      dotClass: 'bg-primary/80',
    }
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={'In-Game Chat'}
        description={
          'Broadcast messages to all connected players and see their chat in real time.'
        }
        icon={<MessagesSquare className="w-5 h-5" />}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={fetchPlayers}
            className="gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            {'Refresh'}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="relative h-[calc(100vh-260px)] min-h-[420px] flex flex-col rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/50 bg-muted/30 select-none shrink-0">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <MessagesSquare className="w-3.5 h-3.5" />
                <span>{'chat stream'}</span>
                <span className="text-muted-foreground/50 normal-case tracking-normal font-normal">
                  ·
                </span>
                <span className="text-muted-foreground/70 normal-case tracking-normal font-normal tabular-nums">
                  {Number(chatHistory.length) === 1
                    ? String(chatHistory.length) + ' msg'
                    : String(chatHistory.length) + ' msgs'}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground normal-case tracking-normal font-normal">
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    socket?.connected
                      ? 'bg-emerald-400 animate-pulse'
                      : 'bg-muted-foreground/40',
                  )}
                />
                <span>{socket?.connected ? 'LIVE' : 'OFFLINE'}</span>
              </span>
            </div>

            <div className="flex-1 flex flex-col p-0 min-h-0">
              <ScrollArea
                className="flex-1 px-3"
                role="log"
                aria-live="polite"
                aria-label={'Chat messages'}
              >
                <div className="py-3 space-y-2">
                  {chatHistory.length === 0 ? (
                    <EmptyState
                      type="noMessages"
                      title={'No chat messages yet'}
                      description={
                        'Player messages and your broadcasts will appear here in real time.'
                      }
                      compact
                    />
                  ) : (
                    chatHistory.map((msg) => {
                      const meta = getMessageMeta(msg)
                      return (
                        <div key={msg.id} className={getMessageStyle(msg.type)}>
                          <div className="flex items-center justify-between mb-0.5">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={cn(
                                  'w-1.5 h-1.5 rounded-full shrink-0',
                                  meta.dotClass,
                                )}
                              />
                              <span
                                className={cn(
                                  'font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-1',
                                  meta.labelClass,
                                )}
                              >
                                {meta.icon}
                                {meta.label}
                              </span>
                            </div>
                            <time
                              dateTime={msg.timestamp.toISOString()}
                              className="font-mono text-[10px] tabular-nums text-muted-foreground/60"
                            >
                              {msg.timestamp.toLocaleTimeString('en')}
                            </time>
                          </div>
                          <p className="text-sm text-foreground/90 [overflow-wrap:anywhere]">
                            {msg.message}
                          </p>
                        </div>
                      )
                    })
                  )}
                  <div ref={chatEndRef} />
                </div>
              </ScrollArea>

              <div className="p-3 border-t border-border/50 bg-muted/20">
                {nativeChatAvailable !== null && (
                  <div className="flex items-center gap-1.5 pb-2 text-[11px] text-muted-foreground/80">
                    <span
                      className={cn(
                        'w-1.5 h-1.5 rounded-full shrink-0',
                        nativeChatAvailable ? 'bg-emerald-400' : 'bg-amber-400',
                      )}
                    />
                    {nativeChatAvailable
                      ? 'chat delivery: native'
                      : 'chat delivery: RCON fallback (native chat API unavailable)'}
                  </div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="flex items-center gap-1.5">
                    <Select
                      value={channel}
                      onValueChange={(v) => setChannel(v as ChatChannel)}
                      disabled={sending}
                    >
                      <SelectTrigger
                        className="h-10 sm:w-52 font-mono text-[11px] uppercase tracking-[0.16em] bg-card/70 border-border/55"
                        aria-label={'Chat channel'}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="server">
                          <span className="flex items-center gap-2">
                            <Megaphone className="w-3.5 h-3.5 text-amber-400" />
                            {'Server broadcast'}
                          </span>
                        </SelectItem>
                        <SelectItem value="admin">
                          <span className="flex items-center gap-2">
                            <Shield className="w-3.5 h-3.5 text-destructive" />
                            {'Admin chat'}
                          </span>
                        </SelectItem>
                        <SelectItem value="general">
                          <span className="flex items-center gap-2">
                            <MessageSquare className="w-3.5 h-3.5 text-primary" />
                            {'General chat'}
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <HelpTip label={'Chat channel'}>
                      {'Server broadcast shows a banner every player sees immediately. Admin chat is visible only to other admins — players never see it. General chat posts a normal-looking message from "' +
                        String('Admin') +
                        '" into everyone\'s regular chat, easy to miss and indistinguishable from a real player named ' +
                        String('Admin') +
                        '.'}
                    </HelpTip>
                  </div>
                  <Input
                    ref={messageInputRef}
                    placeholder={
                      channel === 'admin'
                        ? 'admins only…'
                        : channel === 'general'
                          ? 'post as Admin…'
                          : 'broadcast to all players…'
                    }
                    aria-label={'Chat message'}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={sending}
                    maxLength={500}
                    className="h-10 flex-1 bg-card/70 border-border/55 focus-visible:border-primary/60 placeholder:text-sm"
                  />
                  <DisabledReason
                    reason={
                      !canSendChat
                        ? "You don't have permission to send chat messages."
                        : null
                    }
                  >
                    <Button
                      onClick={sendMessage}
                      disabled={sending || !message.trim() || !canSendChat}
                      className="h-10 min-w-20 sm:min-w-24 gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                    >
                      {sending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <>
                          <Send className="w-3.5 h-3.5" />
                          {'send'}
                        </>
                      )}
                    </Button>
                  </DisabledReason>
                </div>
                <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/65">
                  <span>
                    {channel === 'admin'
                      ? 'admins only — hidden from regular players'
                      : players.length === 0
                        ? 'no players online — server log only'
                        : Number(players.length) === 1
                          ? 'broadcasting to ' +
                            String(players.length) +
                            ' player'
                          : 'broadcasting to ' +
                            String(players.length) +
                            ' players'}
                  </span>
                  <span
                    className={cn(
                      'tabular-nums',
                      message.length > 450 ? 'text-amber-400' : '',
                    )}
                  >
                    {message.length}/500
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="relative rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-md overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/50 bg-muted/30 select-none">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Users className="w-3.5 h-3.5" />
                <span>{'players'}</span>
              </span>
              <span className="text-xs text-muted-foreground tabular-nums normal-case tracking-normal font-normal">
                {String(players.length) + ' online'}
              </span>
            </div>
            <div className="p-2">
              {players.length === 0 ? (
                <div className="px-2 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60 italic">
                  {'no players connected'}
                </div>
              ) : (
                <div className="space-y-1">
                  {players.map((player) => (
                    <div
                      key={player.name}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-muted/40 transition-colors min-w-0"
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse"
                        aria-hidden="true"
                      />
                      <span className="text-xs font-medium text-foreground/90 truncate">
                        {player.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="relative rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-md overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/50 bg-muted/30 select-none">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Megaphone className="w-3.5 h-3.5" />
                <span>{'quick broadcasts'}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 -my-1 text-xs"
                onClick={() => {
                  setPresetsEditing((v) => !v)
                  setEditingIdx(null)
                  setEditingDraft('')
                  setNewPresetDraft('')
                }}
                aria-label={
                  presetsEditing ? 'Done editing presets' : 'Edit presets'
                }
              >
                {presetsEditing ? (
                  <>
                    <Check className="w-3 h-3 me-1" />
                    {'done'}
                  </>
                ) : (
                  <>
                    <Pencil className="w-3 h-3 me-1" />
                    {'edit'}
                  </>
                )}
              </Button>
            </div>
            <div className="p-2 space-y-1.5">
              {presets.length === 0 && !presetsEditing && (
                <p className="px-2 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">
                  {'// no presets — click edit to add'}
                </p>
              )}
              {presets.map((quickMsg, idx) => {
                const isEditing = presetsEditing && editingIdx === idx
                if (isEditing) {
                  return (
                    <div
                      key={`edit-${idx}`}
                      className="flex items-center gap-1"
                    >
                      <Input
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleSaveEdit()
                          }
                          if (e.key === 'Escape') {
                            setEditingIdx(null)
                            setEditingDraft('')
                          }
                        }}
                        maxLength={500}
                        autoFocus
                        className="h-9 flex-1 text-sm"
                      />
                      <DisabledReason
                        reason={
                          !canManagePresets
                            ? "You don't have permission to manage quick broadcast presets."
                            : null
                        }
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9"
                          onClick={handleSaveEdit}
                          disabled={!canManagePresets}
                          aria-label={'Save'}
                        >
                          <Check className="w-4 h-4" />
                        </Button>
                      </DisabledReason>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        onClick={() => {
                          setEditingIdx(null)
                          setEditingDraft('')
                        }}
                        aria-label={'Cancel'}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  )
                }
                return (
                  <div
                    key={`preset-${idx}`}
                    className="flex items-center gap-1"
                  >
                    <button
                      type="button"
                      className="group flex-1 min-h-9 px-2 py-1.5 text-start rounded-sm bg-muted/15 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 transition-colors text-xs text-foreground/85 whitespace-normal"
                      onClick={() => {
                        if (presetsEditing) {
                          setEditingIdx(idx)
                          setEditingDraft(quickMsg)
                        } else {
                          setMessage(quickMsg)
                          messageInputRef.current?.focus()
                        }
                      }}
                    >
                      {quickMsg}
                    </button>
                    {presetsEditing && (
                      <DisabledReason
                        reason={
                          !canManagePresets
                            ? "You don't have permission to manage quick broadcast presets."
                            : null
                        }
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-destructive hover:text-destructive"
                          onClick={() => handleDeletePreset(idx)}
                          disabled={!canManagePresets}
                          aria-label={'Delete preset ' + String(idx + 1)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </DisabledReason>
                    )}
                  </div>
                )
              })}
              {presetsEditing && (
                <div className="flex items-center gap-1 pt-2 mt-1 border-t border-border/40">
                  <Input
                    placeholder={'add a new quick message…'}
                    value={newPresetDraft}
                    onChange={(e) => setNewPresetDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        handleAddPreset()
                      }
                    }}
                    maxLength={500}
                    className="h-9 flex-1 text-sm bg-card/70 border-border/55"
                  />
                  <DisabledReason
                    reason={
                      !canManagePresets
                        ? "You don't have permission to manage quick broadcast presets."
                        : null
                    }
                  >
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9"
                      onClick={handleAddPreset}
                      disabled={!newPresetDraft.trim() || !canManagePresets}
                      aria-label={'Add preset'}
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  </DisabledReason>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
