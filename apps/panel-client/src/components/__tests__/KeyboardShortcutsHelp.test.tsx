import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KeyboardShortcutsHelp } from '../KeyboardShortcutsHelp'
import type { ShortcutDef } from '@/hooks/useKeyboardShortcuts'

const SHORTCUTS: ShortcutDef[] = [
  { key: '1', label: 'Dashboard', group: 'Navigation' },
  { key: '2', label: 'Console', group: 'Navigation' },
  { key: 'Ctrl+S', label: 'Save', group: 'Page Actions' },
]

describe('KeyboardShortcutsHelp', () => {
  it('renders nothing when closed', () => {
    render(<KeyboardShortcutsHelp open={false} onClose={vi.fn()} shortcuts={SHORTCUTS} />)
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()
  })

  it('groups shortcuts under their real group headings, not a flat list', () => {
    render(<KeyboardShortcutsHelp open onClose={vi.fn()} shortcuts={SHORTCUTS} />)
    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.getByText('Page Actions')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Save')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+S')).toBeInTheDocument()
  })

  it('does not silently drop a shortcut with an unrecognized group', () => {
    render(
      <KeyboardShortcutsHelp
        open
        onClose={vi.fn()}
        shortcuts={[...SHORTCUTS, { key: 'X', label: 'Mystery action', group: 'Experimental' }]}
      />
    )
    expect(screen.getByText('Experimental')).toBeInTheDocument()
    expect(screen.getByText('Mystery action')).toBeInTheDocument()
  })

  it('calls onClose when dismissed (Escape), not just on an explicit close button', () => {
    const onClose = vi.fn()
    render(<KeyboardShortcutsHelp open onClose={onClose} shortcuts={SHORTCUTS} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
