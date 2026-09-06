import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BridgeStatusBadge } from '../BridgeStatusBadge'
import en from '@/locales/en/bridgeStatusBadge.json'

function renderBadge(props: Partial<Parameters<typeof BridgeStatusBadge>[0]>) {
  return render(
    <MemoryRouter>
      <BridgeStatusBadge connected={false} {...props} />
    </MemoryRouter>
  )
}

describe('BridgeStatusBadge', () => {
  it('reports connected when the bridge is connected', () => {
    renderBadge({ connected: true, running: true })
    expect(screen.getByText(en.connected.label)).toBeInTheDocument()
  })

  it('does not claim connected just because the server is running', () => {
    renderBadge({ connected: false, running: true })
    expect(screen.getByText(en.waiting.label)).toBeInTheDocument()
    expect(screen.queryByText(en.connected.label)).not.toBeInTheDocument()
  })

  it('reports offline when neither connected nor running', () => {
    renderBadge({ connected: false, running: false })
    expect(screen.getByText(en.offline.label)).toBeInTheDocument()
  })

  it('loading overrides a stale connected flag rather than asserting it', () => {
    renderBadge({ connected: true, loading: true })
    expect(screen.getByText(en.loading.label)).toBeInTheDocument()
    expect(screen.queryByText(en.connected.label)).not.toBeInTheDocument()
  })

  it('surfaces the bridge path in the tooltip so operators can verify it', () => {
    renderBadge({ connected: true, bridgePath: '/opt/pz/mods/bridge' })
    expect(screen.getByRole('link')).toHaveAttribute('title', expect.stringContaining('/opt/pz/mods/bridge'))
  })

  it('surfaces the offline hint pointing at Settings when disconnected', () => {
    renderBadge({ connected: false, running: false })
    expect(screen.getByRole('link')).toHaveAttribute(
      'title',
      expect.stringContaining(en.offline.hint)
    )
  })

  it('prefers an explicit summary over the generic hint', () => {
    renderBadge({ connected: false, running: false, summary: 'Custom detail from server' })
    const el = screen.getByRole('link')
    expect(el.getAttribute('title')).toContain('Custom detail from server')
    expect(el.getAttribute('title')).not.toContain(en.offline.hint)
  })

  it('the accessible name leads with the visible state word and still includes the hint/path detail -- without an explicit aria-label the state word alone would be silently dropped from what a screen reader announces', () => {
    renderBadge({ connected: false, running: false, bridgePath: '/opt/pz/mods/bridge' })
    const el = screen.getByRole('link')
    expect(el).toHaveAccessibleName(`${en.offline.label}\n${en.offline.hint}\nPath: /opt/pz/mods/bridge`)
  })

  it('still has a real accessible name when there is no hint or path to add (loading has neither) -- previously this was a completely silent live region', () => {
    renderBadge({ connected: true, loading: true })
    const el = screen.getByRole('link')
    expect(el).toHaveAccessibleName(en.loading.label)
  })

  describe('interactive (default)', () => {
    it('is a real click target to the Bridge settings tab -- the hint text used to point somewhere it could not take you', () => {
      renderBadge({ connected: false, running: false })
      expect(screen.getByRole('link')).toHaveAttribute('href', '/settings?tab=bridge')
    })
  })

  describe('interactive={false}', () => {
    it('renders a non-interactive status region instead of a link, for the one call site that already lives on the destination it would link to', () => {
      renderBadge({ connected: false, running: false, interactive: false })
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
      const el = screen.getByRole('status')
      expect(el).toHaveAccessibleName(`${en.offline.label}\n${en.offline.hint}`)
    })
  })
})
