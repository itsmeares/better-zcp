import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HelpTip } from '@/components/HelpTip'
import { VerdictBand, WorkList, type Verdict, type WorkItem } from '../dashboard/DashboardVerdict'

function renderBand(props: Partial<Parameters<typeof VerdictBand>[0]> = {}) {
  const defaults: Parameters<typeof VerdictBand>[0] = {
    verdict: { level: 'calm' },
    players: [],
    showPresence: true,
    lastUpdated: new Date(),
    stale: false,
  }
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <VerdictBand {...defaults} {...props} />
      </TooltipProvider>
    </MemoryRouter>
  )
}

describe('VerdictBand', () => {
  it('a critical verdict gets role="alert" -- screen readers must interrupt for it, not read it as routine status', () => {
    renderBand({ verdict: { level: 'critical', headline: 'Server crashed' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('a calm verdict gets role="status" instead, not role="alert"', () => {
    renderBand({ verdict: { level: 'calm' } })
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a warning verdict also gets role="status", not "alert" -- only critical interrupts', () => {
    renderBand({ verdict: { level: 'warning', headline: 'Disk getting full' } })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('omits the headline block entirely when calm and nothing is wrong -- a healthy panel should not announce itself', () => {
    renderBand({ verdict: { level: 'calm' } })
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('reports a stale link instead of a falsely-fresh timestamp', () => {
    const old = new Date(Date.now() - 5 * 60_000)
    renderBand({ lastUpdated: old, stale: true })
    expect(screen.getByText(/link may be stale/)).toBeInTheDocument()
  })

  it('does not claim staleness when the link is fresh', () => {
    renderBand({ lastUpdated: new Date(), stale: false })
    expect(screen.queryByText(/link may be stale/)).not.toBeInTheDocument()
    expect(screen.getByText('updated just now')).toBeInTheDocument()
  })

  it('shows "no update yet" rather than a bogus elapsed time when there has never been an update', () => {
    renderBand({ lastUpdated: null, stale: false })
    expect(screen.getByText('no update yet')).toBeInTheDocument()
  })

  it('renders accented, non-ASCII player names verbatim', () => {
    renderBand({ players: [{ name: 'Aurélie', since: '5m' }] })
    expect(screen.getByText('Aurélie')).toBeInTheDocument()
  })

  it('caps the visible player list at 10 and reports the real overflow count, not a silently truncated list', () => {
    const players = Array.from({ length: 13 }, (_, i) => ({ name: `Player${i}` }))
    renderBand({ players })
    for (let i = 0; i < 10; i++) expect(screen.getByText(`Player${i}`)).toBeInTheDocument()
    expect(screen.queryByText('Player10')).not.toBeInTheDocument()
    expect(screen.getByText('and 3 more')).toBeInTheDocument()
  })

  it('hides the presence list entirely when showPresence is false, even with players online', () => {
    renderBand({ showPresence: false, players: [{ name: 'Aurélie' }] })
    expect(screen.queryByText('Aurélie')).not.toBeInTheDocument()
  })

  it('a Link-style action navigates via href, an onClick-style action calls the handler -- and neither is silently disabled', () => {
    const onClick = vi.fn()
    renderBand({
      verdict: { level: 'warning', headline: 'Fix me', action: { label: 'Fix it', onClick } },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Fix it' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('a busy action is disabled and does not fire onClick', () => {
    const onClick = vi.fn()
    renderBand({
      verdict: { level: 'warning', headline: 'Fix me', action: { label: 'Fix it', onClick, busy: true } },
    })
    const btn = screen.getByRole('button', { name: 'Fix it' })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders a HelpTip passed as headlineHelp next to the headline -- the seam that lets an unexplained term in the status banner (e.g. "RCON disconnected") carry its own definition', async () => {
    renderBand({
      verdict: {
        level: 'warning',
        headline: 'RCON disconnected',
        headlineHelp: <HelpTip label="RCON">Remote console used to send commands to the game.</HelpTip>,
      },
    })
    expect(screen.getByText('RCON disconnected')).toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Help: RCON' })
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByText('Remote console used to send commands to the game.')).toBeInTheDocument())
  })

  it('omits headlineHelp cleanly when not provided -- the common case stays unchanged', () => {
    renderBand({ verdict: { level: 'warning', headline: 'Disk getting full' } })
    expect(screen.queryByRole('button', { name: /^Help:/ })).not.toBeInTheDocument()
  })

  it('a link-style action renders a real navigable link to the real destination', () => {
    renderBand({
      verdict: { level: 'warning', headline: 'Check backups', action: { label: 'Go to Backups', to: '/backups' } },
    })
    expect(screen.getByRole('link', { name: /Go to Backups/ })).toHaveAttribute('href', '/backups')
  })
})

describe('WorkList', () => {
  const Icon = (() => <svg />) as any

  it('renders each destination with its real live state and links to the real path', () => {
    const items: WorkItem[] = [
      { id: 'backups', to: '/backups', icon: Icon, label: 'Backups', state: '3 pending', tone: 'warning' },
    ]
    render(
      <MemoryRouter>
        <WorkList items={items} />
      </MemoryRouter>
    )
    const link = screen.getByRole('link', { name: /Backups/ })
    expect(link).toHaveAttribute('href', '/backups')
    expect(screen.getByText('3 pending')).toHaveClass('text-warning')
  })

  it('a "bad" tone item is visually distinguished from a "good" one -- both cannot look the same', () => {
    const items: WorkItem[] = [
      { id: 'a', to: '/a', icon: Icon, label: 'A', state: 'broken', tone: 'bad' },
      { id: 'b', to: '/b', icon: Icon, label: 'B', state: 'fine', tone: 'good' },
    ]
    render(
      <MemoryRouter>
        <WorkList items={items} />
      </MemoryRouter>
    )
    expect(screen.getByText('broken')).toHaveClass('text-destructive')
    expect(screen.getByText('fine')).toHaveClass('text-success/80')
  })

  it('keeps rows with the same destination distinct across live sorting rerenders', () => {
    const items: WorkItem[] = [
      { id: 'console', to: '/console', icon: Icon, label: 'Console', state: 'rcon offline', tone: 'warning' },
      { id: 'errors', to: '/console', icon: Icon, label: 'Errors', state: '2 logged', tone: 'default' },
    ]
    const duplicateKeyWarning = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(
      <MemoryRouter>
        <WorkList items={items} />
      </MemoryRouter>,
    )

    rerender(
      <MemoryRouter>
        <WorkList items={[items[1], items[0]]} />
      </MemoryRouter>,
    )

    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.getByText('Console')).toBeInTheDocument()
    expect(screen.getByText('Errors')).toBeInTheDocument()
    expect(duplicateKeyWarning).not.toHaveBeenCalledWith(expect.stringContaining('same key'))
    duplicateKeyWarning.mockRestore()
  })
})
