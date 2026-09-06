import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi, ApiError } from '@/lib/api'

// bughunt-2026-08-31-c (events-bridgeresultdisplay-needs-a-partial-state):
// Kevin's 4570b52f made PanelBridge.lua's runEventSequence report
// ok = (no step failed) instead of an unconditional true, and added
// failedCount/executed alongside the always-present per-step `results`
// array. Shipped deliberately WITHOUT the UI half -- BridgeResultDisplay
// gated purely on the top-level success flag, so a 9-of-10 partial started
// rendering the plain red "Operation Failed" card, which is still wrong
// (just a different wrong than the green-on-total-failure it replaced).
// This locks in the three real states: all succeeded, partial (N of M
// failed, listed without needing to expand raw JSON), and all failed --
// distinguished from an ordinary bridge failure (which still shows the
// generic red card, unchanged).
//
// Also exercises Events.tsx's other half of this: runBridgeOperation's
// catch branch used to hardcode `data: null` on every failure, discarding
// whatever diagnostic table ApiError.data carried even when present. The
// partial/all-failed cases below only render correctly because that data
// now survives into BridgeResultData.

vi.mock('@/components/ui/select', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  function findAriaLabel(children: React.ReactNode): string | undefined {
    let found: string | undefined
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const label = (child.props as { 'aria-label'?: string })['aria-label']
      if (label) found = label
    })
    return found
  }
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, disabled, children }: { value: string; onValueChange: (v: string) => void; disabled?: boolean; children: React.ReactNode }) {
    return (
      <select
        aria-label={findAriaLabel(children)}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {collectItems(children).map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver
Element.prototype.scrollIntoView = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      sendCommand: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)

function renderEvents() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function openBridgeToolsWithEventSequence() {
  const nav = await screen.findByText('Bridge tools')
  fireEvent.click(nav)
  const combo = await screen.findByRole('combobox', { name: 'Select operation' })
  fireEvent.change(combo, { target: { value: 'runEventSequence' } })
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  sendCommand.mockReset()
})

describe('Events -- BridgeResultDisplay renders a real partial state for runEventSequence', () => {
  it('shows a partial-failure card listing the failed step, not the generic red "Operation Failed" card', async () => {
    sendCommand.mockRejectedValue(
      new ApiError('Event sequence completed with 1/2 step(s) failed', {
        status: 200,
        data: {
          message: 'Event sequence completed with 1/2 step(s) failed',
          executed: 2,
          maxSteps: 20,
          failedCount: 1,
          results: [
            { index: 1, kind: 'chat', success: true, data: { message: 'ok' } },
            { index: 2, kind: 'weather', success: false, error: 'Unsupported weather type' },
          ],
        },
      }),
    )
    renderEvents()
    await openBridgeToolsWithEventSequence()

    fireEvent.click(screen.getByRole('button', { name: 'Run Operation' }))

    await screen.findByText('1 of 2 step(s) failed')
    expect(screen.getByText('Step 2', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/Unsupported weather type/)).toBeInTheDocument()
    // The bug this fixes: a partial must not read as the plain failure card.
    expect(screen.queryByText('Operation Failed')).not.toBeInTheDocument()
  })

  it('shows an all-failed card, distinct from the partial state, when every step failed', async () => {
    sendCommand.mockRejectedValue(
      new ApiError('Event sequence completed with 2/2 step(s) failed', {
        status: 200,
        data: {
          message: 'Event sequence completed with 2/2 step(s) failed',
          executed: 2,
          maxSteps: 20,
          failedCount: 2,
          results: [
            { index: 1, kind: 'chat', success: false, error: 'chat.message required' },
            { index: 2, kind: 'weather', success: false, error: 'Unsupported weather type' },
          ],
        },
      }),
    )
    renderEvents()
    await openBridgeToolsWithEventSequence()

    fireEvent.click(screen.getByRole('button', { name: 'Run Operation' }))

    await screen.findByText('Event sequence failed')
    expect(screen.queryByText('1 of 2 step(s) failed', { exact: false })).not.toBeInTheDocument()
    expect(screen.getByText(/chat\.message required/)).toBeInTheDocument()
    expect(screen.getByText(/Unsupported weather type/)).toBeInTheDocument()
  })

  it('shows the all-succeeded card, with no failed-steps section, when every step succeeded', async () => {
    sendCommand.mockResolvedValue({
      success: true,
      data: {
        message: 'Event sequence executed',
        executed: 2,
        maxSteps: 20,
        failedCount: 0,
        results: [
          { index: 1, kind: 'chat', success: true, data: { message: 'ok' } },
          { index: 2, kind: 'weather', success: true, data: { message: 'ok' } },
        ],
      },
    } as never)
    renderEvents()
    await openBridgeToolsWithEventSequence()

    fireEvent.click(screen.getByRole('button', { name: 'Run Operation' }))

    await screen.findByText('Event sequence completed')
    expect(screen.queryByText('Failed steps')).not.toBeInTheDocument()
    expect(screen.queryByText('Operation Failed')).not.toBeInTheDocument()
  })

  it('still shows the generic failure card for an ordinary (non-sequence-shaped) bridge failure', async () => {
    sendCommand.mockRejectedValue(new Error('Bridge not running'))
    renderEvents()
    await openBridgeToolsWithEventSequence()

    fireEvent.click(screen.getByRole('button', { name: 'Run Operation' }))

    await screen.findByText('Operation Failed')
  })
})
