import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  const { t, i18n } = useTranslation('chat')
  const defaultPresets = t('presets.default', { returnObjects: true }) as string[]
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
  const canSendChat = channel === 'server' ? canSendServerChat : canSendTargetedChat
  const canManagePresets = can('panel.settings')

  const [nativeChatAvailable, setNativeChatAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    if (!canSendServerChat) return
    let active = true
    panelBridgeApi.getChatInfo()
      .then((res) => {
        if (active && res.success && res.data) setNativeChatAvailable(res.data.chatServerAvailable)
      })
      .catch(() => {})
    return () => { active = false }
  }, [canSendServerChat])

  const handleScroll = useCallback(() => {
    const el = scrollViewportRef.current
    if (!el) return
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight)
    stickToBottomRef.current = distance < 80
  }, [])

  useEffect(() => {
    const root = chatEndRef.current?.closest('[data-radix-scroll-area-viewport]') as HTMLDivElement | null
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
    return () => { socket.off('activeServerChanged', fetchPlayers) }
  }, [socket, fetchPlayers])

  useEffect(() => {
    if (socket) {
      const handleSocketMessage = (data: { id?: string; type?: string; author?: string; message?: string; timestamp?: string }) => {
        const msg = data.message
        if (!msg) return
        setChatHistory(prev => {
             const parsedTs = data.timestamp ? Date.parse(data.timestamp) : Number.NaN
             const incomingTs = Number.isFinite(parsedTs) ? parsedTs : Date.now()
             const recent = prev.slice(-20)
             const hasSameSocketId = data.id ? recent.some(m => m.id === data.id) : false
             const bracketedServerEcho = (data.type === 'server' || !data.type)
               ? msg.match(/^\[([^\]]+)\]\s+(.+)$/)
               : null
             const isOptimisticEcho = recent.some(m =>
               m.id.startsWith('local-') &&
               Math.abs(m.timestamp.getTime() - incomingTs) < 15000 &&
               (
                 (m.message === msg && m.author?.toLowerCase() === data.author?.toLowerCase()) ||
                 (bracketedServerEcho !== null &&
                   m.message === bracketedServerEcho[2] &&
                   m.author?.toLowerCase() === bracketedServerEcho[1].toLowerCase())
               )
             )
             if (hasSameSocketId || isOptimisticEcho) return prev

             const newMessage: ChatMessage = {
                id: data.id || `${incomingTs}-${Math.random().toString(36).slice(2, 8)}`,
                type: data.type || 'general',
                author: data.author,
                message: msg,
                timestamp: new Date(incomingTs)
             }

             return [...prev, newMessage].slice(-200)
        })
      }

      socket.on('chat:message', handleSocketMessage)
      return () => { socket.off('chat:message', handleSocketMessage) }
    }
  }, [socket])

  const sendMessage = async () => {
    if (!message.trim() || sendingRef.current || !canSendChat) return
    sendingRef.current = true
    setSending(true)
    try {
      let localType: ChatMessage['type'] = 'server'
      let localAuthor = t('labels.server')
      if (channel === 'admin') {
        await panelBridgeApi.sendToAdminChat(message)
        localType = 'admin'
        localAuthor = t('labels.admin')
      } else if (channel === 'general') {
        await panelBridgeApi.sendToGeneralChat(message, 'Admin')
        localType = 'general'
        localAuthor = t('labels.admin')
      } else {
        await panelBridgeApi.sendToServerChat(message, false)
      }

      const sentAt = new Date()
      setChatHistory(prev => [...prev, {
        id: `local-${sentAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
        type: localType,
        author: localAuthor,
        message: message,
        timestamp: sentAt
      }].slice(-200))
      stickToBottomRef.current = true
      setMessage('')
      toast({
        title:
          channel === 'admin' ? t('toasts.adminSentTitle')
          : channel === 'general' ? t('toasts.generalSentTitle')
          : t('toasts.broadcastSentTitle'),
        description:
          channel === 'admin' ? t('toasts.adminSentDesc')
          : channel === 'general' ? t('toasts.generalSentDesc')
          : t('toasts.broadcastSentDesc'),
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.sendFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    configApi.getAppSettings()
      .then((settings: any) => {
        if (cancelled) return
        const saved = settings?.chatPresets
        if (Array.isArray(saved) && saved.every((p: unknown) => typeof p === 'string')) {
          setPresets(saved.length > 0 ? saved : defaultPresets)
        }
      })
      .catch(() => { /* fall back to defaults silently */ })
    return () => { cancelled = true }
  }, [defaultPresets])

  const persistPresets = useCallback(async (next: string[]) => {
    if (!canManagePresets) return
    let previous: string[] = []
    setPresets(prev => {
      previous = prev
      return next
    })
    try {
      await configApi.updateAppSettings({ chatPresets: next })
    } catch (error) {
      setPresets(previous)
      reportClientError('Failed to save chat presets.', error)
      toast({
        title: t('toasts.presetsSaveFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: 'destructive',
      })
    }
  }, [toast, canManagePresets])

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

  const handleDeletePreset = useCallback(async (idx: number) => {
    const ok = await confirm({
      title: t('quickBroadcasts.deleteConfirmTitle'),
      description: t('quickBroadcasts.deleteConfirmDescription', { preset: presets[idx] }),
      confirmLabel: t('quickBroadcasts.deleteConfirmButton'),
      variant: 'warning',
    })
    if (!ok) return
    const next = presets.filter((_, i) => i !== idx)
    persistPresets(next)
    if (editingIdx === idx) {
      setEditingIdx(null)
      setEditingDraft('')
    }
  }, [confirm, editingIdx, persistPresets, presets, t])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const getMessageStyle = (type: string) => {
    if (type === 'server') return 'border-s-2 border-amber-400/70 bg-amber-400/5 ps-3 pe-3 py-2'
    if (type === 'admin')  return 'border-s-2 border-destructive/70 bg-destructive/5 ps-3 pe-3 py-2'
    return 'border-s-2 border-primary/55 bg-muted/15 ps-3 pe-3 py-2'
  }

  const getMessageMeta = (msg: ChatMessage) => {
    if (msg.type === 'server') return { icon: <Megaphone className="w-3 h-3" />, label: msg.author || t('labels.server'), labelClass: 'text-amber-400', dotClass: 'bg-amber-400/80' }
    if (msg.type === 'admin')  return { icon: <Shield className="w-3 h-3" />,    label: msg.author || t('labels.admin'),  labelClass: 'text-destructive', dotClass: 'bg-destructive/80' }
    return { icon: <MessageSquare className="w-3 h-3" />, label: msg.author || t('labels.player'), labelClass: 'text-primary', dotClass: 'bg-primary/80' }
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        icon={<MessagesSquare className="w-5 h-5" />}
        actions={
          <Button variant="outline" size="sm" onClick={fetchPlayers} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            {t('pageHeader.refresh')}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="relative h-[calc(100vh-260px)] min-h-[420px] flex flex-col rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/50 bg-muted/30 select-none shrink-0">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <MessagesSquare className="w-3.5 h-3.5" />
                <span>{t('chatWindow.streamLabel')}</span>
                <span className="text-muted-foreground/50 normal-case tracking-normal font-normal">·</span>
                <span className="text-muted-foreground/70 normal-case tracking-normal font-normal tabular-nums">{t('chatWindow.msgCount', { count: chatHistory.length })}</span>
              </span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground normal-case tracking-normal font-normal">
                <span className={cn('w-1.5 h-1.5 rounded-full', socket?.connected ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/40')} />
                <span>{socket?.connected ? t('chatWindow.live') : t('chatWindow.offline')}</span>
              </span>
            </div>

            <div className="flex-1 flex flex-col p-0 min-h-0">
              <ScrollArea className="flex-1 px-3" role="log" aria-live="polite" aria-label={t('chatWindow.messagesAria')}>
                <div className="py-3 space-y-2">
                  {chatHistory.length === 0 ? (
                    <EmptyState type="noMessages" title={t('emptyState.title')} description={t('emptyState.description')} compact />
                  ) : (
                    chatHistory.map((msg) => {
                      const meta = getMessageMeta(msg)
                      return (
                        <div key={msg.id} className={getMessageStyle(msg.type)}>
                          <div className="flex items-center justify-between mb-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', meta.dotClass)} />
                              <span className={cn('font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-1', meta.labelClass)}>
                                {meta.icon}
                                {meta.label}
                              </span>
                            </div>
                            <time dateTime={msg.timestamp.toISOString()} className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
                              {msg.timestamp.toLocaleTimeString(i18n.language)}
                            </time>
                          </div>
                          <p className="text-sm text-foreground/90 [overflow-wrap:anywhere]">{msg.message}</p>
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
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', nativeChatAvailable ? 'bg-emerald-400' : 'bg-amber-400')} />
                    {nativeChatAvailable ? t('deliveryStatus.native') : t('deliveryStatus.rconFallback')}
                  </div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="flex items-center gap-1.5">
                    <Select value={channel} onValueChange={(v) => setChannel(v as ChatChannel)} disabled={sending}>
                      <SelectTrigger className="h-10 sm:w-52 font-mono text-[11px] uppercase tracking-[0.16em] bg-card/70 border-border/55" aria-label={t('channel.aria')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="server">
                          <span className="flex items-center gap-2">
                            <Megaphone className="w-3.5 h-3.5 text-amber-400" />
                            {t('channel.server')}
                          </span>
                        </SelectItem>
                        <SelectItem value="admin">
                          <span className="flex items-center gap-2">
                            <Shield className="w-3.5 h-3.5 text-destructive" />
                            {t('channel.admin')}
                          </span>
                        </SelectItem>
                        <SelectItem value="general">
                          <span className="flex items-center gap-2">
                            <MessageSquare className="w-3.5 h-3.5 text-primary" />
                            {t('channel.general')}
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <HelpTip label={t('channel.aria')}>{t('channel.tip', { adminLabel: t('labels.admin') })}</HelpTip>
                  </div>
                  <Input
                    ref={messageInputRef}
                    placeholder={
                      channel === 'admin'
                        ? t('input.placeholderAdmin')
                        : channel === 'general'
                          ? t('input.placeholderGeneral')
                          : t('input.placeholderServer')
                    }
                    aria-label={t('input.aria')}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={sending}
                    maxLength={500}
                    className="h-10 flex-1 bg-card/70 border-border/55 focus-visible:border-primary/60 placeholder:text-sm"
                  />
                  <DisabledReason reason={!canSendChat ? t('input.noPermission') : null}>
                    <Button
                      onClick={sendMessage}
                      disabled={sending || !message.trim() || !canSendChat}
                      className="h-10 min-w-20 sm:min-w-24 gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                    >
                      {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Send className="w-3.5 h-3.5" />{t('input.sendButton')}</>}
                    </Button>
                  </DisabledReason>
                </div>
                <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/65">
                  <span>
                    {channel === 'admin'
                      ? t('footer.adminOnly')
                      : players.length === 0
                        ? t('footer.noPlayersOnline')
                        : t('footer.broadcastingTo', { count: players.length })}
                  </span>
                  <span className={cn('tabular-nums', message.length > 450 ? 'text-amber-400' : '')}>
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
                <span>{t('playersPanel.label')}</span>
              </span>
              <span className="text-xs text-muted-foreground tabular-nums normal-case tracking-normal font-normal">{t('playersPanel.onlineCount', { count: players.length })}</span>
            </div>
            <div className="p-2">
              {players.length === 0 ? (
                <div className="px-2 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60 italic">
                  {t('playersPanel.noPlayersConnected')}
                </div>
              ) : (
                <div className="space-y-1">
                  {players.map((player) => (
                    <div key={player.name} className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-muted/40 transition-colors min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse" aria-hidden="true" />
                      <span className="text-xs font-medium text-foreground/90 truncate">{player.name}</span>
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
                <span>{t('quickBroadcasts.label')}</span>
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
                aria-label={presetsEditing ? t('quickBroadcasts.doneAria') : t('quickBroadcasts.editAria')}
              >
                {presetsEditing ? <><Check className="w-3 h-3 me-1" />{t('quickBroadcasts.done')}</> : <><Pencil className="w-3 h-3 me-1" />{t('quickBroadcasts.edit')}</>}
              </Button>
            </div>
            <div className="p-2 space-y-1.5">
              {presets.length === 0 && !presetsEditing && (
                <p className="px-2 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">{t('quickBroadcasts.noPresets')}</p>
              )}
              {presets.map((quickMsg, idx) => {
                const isEditing = presetsEditing && editingIdx === idx
                if (isEditing) {
                  return (
                    <div key={`edit-${idx}`} className="flex items-center gap-1">
                      <Input
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleSaveEdit() }
                          if (e.key === 'Escape') { setEditingIdx(null); setEditingDraft('') }
                        }}
                        maxLength={500}
                        autoFocus
                        className="h-9 flex-1 text-sm"
                      />
                      <DisabledReason reason={!canManagePresets ? t('quickBroadcasts.noPermission') : null}>
                        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleSaveEdit} disabled={!canManagePresets} aria-label={t('quickBroadcasts.saveAria')}>
                          <Check className="w-4 h-4" />
                        </Button>
                      </DisabledReason>
                      <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => { setEditingIdx(null); setEditingDraft('') }} aria-label={t('quickBroadcasts.cancelAria')}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  )
                }
                return (
                  <div key={`preset-${idx}`} className="flex items-center gap-1">
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
                      <DisabledReason reason={!canManagePresets ? t('quickBroadcasts.noPermission') : null}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-destructive hover:text-destructive"
                          onClick={() => handleDeletePreset(idx)}
                          disabled={!canManagePresets}
                          aria-label={t('quickBroadcasts.deleteAria', { index: idx + 1 })}
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
                    placeholder={t('quickBroadcasts.addPlaceholder')}
                    value={newPresetDraft}
                    onChange={(e) => setNewPresetDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleAddPreset() }
                    }}
                    maxLength={500}
                    className="h-9 flex-1 text-sm bg-card/70 border-border/55"
                  />
                  <DisabledReason reason={!canManagePresets ? t('quickBroadcasts.noPermission') : null}>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9"
                      onClick={handleAddPreset}
                      disabled={!newPresetDraft.trim() || !canManagePresets}
                      aria-label={t('quickBroadcasts.addAria')}
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
