import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { vi } from 'vitest'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'


class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

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

async function openTimeSpeedSection() {
  const nav = await screen.findByText('Time speed')
  fireEvent.click(nav)
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
})

describe('Events -- time speed slider reflects the server\'s real multiplier instead of a stale local guess', () => {
  it('shows the polled multiplier, not the useState(1) default, once the bridge reports one', async () => {
    getGameTime.mockResolvedValue({
      success: true,
      data: { hour: 12, day: 5, month: 3, multiplier: 10 },
    } as never)

    renderEvents()
    await openTimeSpeedSection()

    await waitFor(() => expect(screen.getByText('10x')).toBeTruthy())
  })

  it('does not clobber an in-progress drag with a poll tick', async () => {
    getGameTime.mockResolvedValue({
      success: true,
      data: { hour: 12, day: 5, month: 3, multiplier: 10 },
    } as never)

    vi.useFakeTimers()
    try {
      renderEvents()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      act(() => { fireEvent.click(screen.getByText('Time speed')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText('10x')).toBeTruthy()

      await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
      act(() => { fireEvent.click(screen.getByRole('button', { name: '24×' })) })
      expect(screen.getByText('24x')).toBeTruthy()

      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

      expect(screen.getByText('24x')).toBeTruthy()
      expect(screen.queryByText('10x')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('styles "apply speed" the same as the page\'s other Apply-All buttons, not outline', async () => {
    getGameTime.mockResolvedValue({
      success: true,
      data: { hour: 12, day: 5, month: 3, multiplier: 1 },
    } as never)

    renderEvents()
    await openTimeSpeedSection()

    const applySpeed = await screen.findByRole('button', { name: /apply speed/i })
    expect(applySpeed).not.toHaveAttribute('data-variant', 'outline')
  })
})
