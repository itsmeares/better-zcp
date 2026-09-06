import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Socket } from 'socket.io-client'
import { ConnectionStatus } from '../ConnectionStatus'
import { SocketContext, ConnectionStatusContext, type ConnectionStatus as Status } from '@/contexts/SocketContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import en from '@/locales/en/connectionStatus.json'

function renderWithStatus(
  status: Status,
  props: { showLabel?: boolean } = {},
  socket: Partial<Socket> | null = null
) {
  return render(
    <SocketContext.Provider value={socket as Socket | null}>
      <ConnectionStatusContext.Provider value={status}>
        <TooltipProvider>
          <ConnectionStatus {...props} />
        </TooltipProvider>
      </ConnectionStatusContext.Provider>
    </SocketContext.Provider>
  )
}

const connected: Status = { connected: true, reconnecting: false, reconnectAttempt: 0, error: null }
const reconnectingEarly: Status = { connected: false, reconnecting: true, reconnectAttempt: 1, error: null }
const reconnecting: Status = { connected: false, reconnecting: true, reconnectAttempt: 3, error: null }
const disconnected: Status = { connected: false, reconnecting: false, reconnectAttempt: 0, error: null }
const disconnectedWithError: Status = {
  connected: false,
  reconnecting: false,
  reconnectAttempt: 0,
  error: 'socket hang up',
}

describe('ConnectionStatus', () => {
  it('renders nothing when fully connected -- a stale "connected" badge would be noise, not signal', () => {
    const { container } = renderWithStatus(connected)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the real reconnect attempt count while reconnecting, not a generic spinner', () => {
    renderWithStatus(reconnecting, { showLabel: true })
    expect(screen.getByText(en.reconnecting.label)).toBeInTheDocument()
  })

  it('does not show the reverse-proxy hint on an early reconnect attempt -- a single retry is normal network noise', async () => {
    renderWithStatus(reconnectingEarly, { showLabel: true })
    fireEvent.focus(screen.getByText(en.reconnecting.label).closest('div')!)
    // Give the tooltip a beat to render, then confirm the hint text never appears.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(en.reconnecting.hint)).not.toBeInTheDocument()
  })

  it('shows the reverse-proxy hint once reconnect attempts pile up', async () => {
    renderWithStatus(reconnecting, { showLabel: true })
    fireEvent.focus(screen.getByText(en.reconnecting.label).closest('div')!)
    expect(await screen.findByText(en.reconnecting.hint)).toBeInTheDocument()
  })

  it('always shows the reassurance description on disconnect -- the page loaded, so the server is reachable', async () => {
    renderWithStatus(disconnectedWithError, { showLabel: true })
    expect(screen.getByText(en.disconnected.label)).toBeInTheDocument()

    fireEvent.focus(screen.getByText(en.disconnected.label).closest('div')!)
    expect(await screen.findByText(en.disconnected.description)).toBeInTheDocument()
  })

  it('appends the real backend error as a separate technical-detail line when one is known, not a canned string', async () => {
    renderWithStatus(disconnectedWithError, { showLabel: true })
    fireEvent.focus(screen.getByText(en.disconnected.label).closest('div')!)
    expect(await screen.findByText('Technical detail: socket hang up')).toBeInTheDocument()
  })

  it('omits the technical-detail line entirely when no backend error is known', async () => {
    renderWithStatus(disconnected, { showLabel: true })
    fireEvent.focus(screen.getByText(en.disconnected.label).closest('div')!)
    await screen.findByText(en.disconnected.hint)
    expect(screen.queryByText(/Technical detail:/)).not.toBeInTheDocument()
  })

  it('keeps the label visually hidden (not absent) when showLabel is false, for screen readers', () => {
    renderWithStatus(disconnected)
    expect(screen.queryByText(en.disconnected.label, { selector: 'span:not(.sr-only)' })).not.toBeInTheDocument()
    expect(screen.getByText(en.disconnected.label, { selector: '.sr-only' })).toBeInTheDocument()
  })

  // The manual retry affordance: the case where neither of App.tsx's
  // visibilitychange/online recovery triggers can ever fire -- the tab was
  // visible and the network never dropped, the server was simply down the
  // whole time -- so this button is the operator's only path back short of
  // a full page refresh.
  it('shows a Retry button in the terminal disconnected state, and clicking it calls socket.connect()', async () => {
    const connect = vi.fn()
    renderWithStatus(disconnected, { showLabel: true }, { connect })
    fireEvent.focus(screen.getByText(en.disconnected.label).closest('div')!)

    const retryButton = await screen.findByRole('button', { name: en.disconnected.retry })
    fireEvent.click(retryButton)

    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('does not show a Retry button while still automatically reconnecting -- the loop is already trying on its own', async () => {
    renderWithStatus(reconnecting, { showLabel: true })
    fireEvent.focus(screen.getByText(en.reconnecting.label).closest('div')!)
    await screen.findByText(en.reconnecting.hint)
    expect(screen.queryByRole('button', { name: en.disconnected.retry })).not.toBeInTheDocument()
  })
})
