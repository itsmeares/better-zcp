import { useEffect, useCallback, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { NAV_ITEMS } from '@/components/shell/nav'

export interface ShortcutDef {
  key: string
  label: string
  group: string
}

const NAV_SHORTCUTS = NAV_ITEMS.filter((item) => item.shortcut)

export const SHORTCUTS: ShortcutDef[] = [
  { key: 'Ctrl+K', label: 'Go to a page or run a command', group: 'General' },
  { key: 'Ctrl+B', label: 'Collapse or expand the sidebar', group: 'General' },
  { key: '?', label: 'Show keyboard shortcuts', group: 'General' },
  ...NAV_SHORTCUTS.map((item) => ({ key: item.shortcut!, label: item.label, group: 'Pages' })),
  { key: 'Ctrl+S', label: 'Save (Configuration, Settings)', group: 'On a page' },
  { key: 'R', label: 'Refresh (Overview)', group: 'On a page' },
  { key: '`', label: 'Switch tab (Console)', group: 'On a page' },
  { key: 'A', label: 'Toggle auto-scroll (Console)', group: 'On a page' },
  { key: '/', label: 'Search the map (Map)', group: 'On a page' },
  { key: ', .', label: 'Floor down, floor up (Map)', group: 'On a page' },
]

function isInputFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable
}

/** Global shortcuts: number keys for pages and ? for the help dialog. */
export function useKeyboardShortcuts() {
  const navigate = useNavigate()
  const [helpOpen, setHelpOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isInputFocused() || e.ctrlKey || e.altKey || e.metaKey) return
      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen((open) => !open)
        return
      }
      const item = NAV_SHORTCUTS.find((nav) => nav.shortcut === e.key)
      if (item) {
        e.preventDefault()
        void navigate({ to: item.to })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate])

  return { helpOpen, setHelpOpen }
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
