import { useEffect, useCallback, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

export interface ShortcutDef {
  key: string
  label: string
  path?: string
  action?: () => void
  group: string
}

function buildNavShortcuts(): ShortcutDef[] {
  const group = 'Navigation'
  return [
    { key: '1', label: 'Dashboard', path: '/', group },
    { key: '2', label: 'Console', path: '/console', group },
    { key: '3', label: 'Players', path: '/players', group },
    { key: '4', label: 'Chat', path: '/chat', group },
    { key: '5', label: 'Events', path: '/events', group },
    { key: '6', label: 'Mods', path: '/mods', group },
    { key: '7', label: 'Backups', path: '/backups', group },
    { key: '8', label: 'Server Config', path: '/server-config', group },
    { key: '9', label: 'Settings', path: '/settings', group },
  ]
}

function buildPageShortcuts(): ShortcutDef[] {
  const group = 'Page Actions'
  return [
    { key: 'Ctrl+S', label: 'Save', group },
    { key: 'Ctrl+K', label: 'Focus search', group },
    { key: 'R', label: 'Refresh (Dashboard)', group },
    { key: '`', label: 'Switch console tab', group },
    { key: 'A', label: 'Toggle auto-scroll (Console)', group },
  ]
}

function isInputFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if ((el as HTMLElement).isContentEditable) return true
  return false
}

export function useKeyboardShortcuts() {
  const navigate = useNavigate()
  const [helpOpen, setHelpOpen] = useState(false)

  const navShortcuts = buildNavShortcuts()

  const allShortcuts: ShortcutDef[] = [
    ...navShortcuts,
    ...buildPageShortcuts(),
    {
      key: '?',
      label: 'Show keyboard shortcuts',
      action: () => setHelpOpen(true),
      group: 'General',
    },
  ]

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isInputFocused()) return
      if (e.ctrlKey || e.altKey || e.metaKey) return

      const key = e.key

      if (key === '?') {
        e.preventDefault()
        setHelpOpen((prev) => !prev)
        return
      }

      if (key === 'Escape') {
        setHelpOpen(false)
        return
      }

      const shortcut = navShortcuts.find((s) => s.key === key)
      if (shortcut?.path) {
        e.preventDefault()
        void navigate({ to: shortcut.path as never })
      }
    },
    [navigate, navShortcuts],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return { helpOpen, setHelpOpen, shortcuts: allShortcuts }
}

export function usePageShortcut(
  key: string,
  handler: () => void,
  options: { ctrl?: boolean } = {},
) {
  const stableHandler = useCallback(handler, [handler])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const wantsCtrl = options.ctrl ?? false
      const hasCtrl = e.ctrlKey || e.metaKey

      if (wantsCtrl && !hasCtrl) return
      if (!wantsCtrl && hasCtrl) return
      if (!wantsCtrl && isInputFocused()) return
      if (e.altKey) return
      if (e.key.toLowerCase() !== key.toLowerCase()) return

      e.preventDefault()
      stableHandler()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [key, stableHandler, options.ctrl])
}
