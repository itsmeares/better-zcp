import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// 2026-08-31 quality pass, operator-approved aesthetic fix: below `lg` the
// sidebar/content grid collapses to one column, so picking a control from
// the ~18-item nav left the selected section's own panel below everything
// else on the page -- reaching it cost a full scroll past the whole nav (and
// Recent Actions) every time. Scoped narrowly to that case: on a narrow
// viewport, picking a section now scrolls the content panel into view;
// desktop (where nav and content are already both visible) is untouched.

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

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

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

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  Element.prototype.scrollIntoView = vi.fn()
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
})

describe('Events -- narrow-viewport nav selection scrolls the content panel into view', () => {
  it('calls scrollIntoView when matchMedia reports a narrow (below-lg) viewport', async () => {
    stubMatchMedia(true)
    renderEvents()

    const nav = await screen.findByText('Severe weather')
    fireEvent.click(nav)

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('does not call scrollIntoView when matchMedia reports a wide (lg+) viewport', async () => {
    stubMatchMedia(false)
    renderEvents()

    const nav = await screen.findByText('Severe weather')
    fireEvent.click(nav)

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it('does not throw when matchMedia is unavailable (every other Events.tsx test, and some real embedded webviews)', async () => {
    vi.stubGlobal('matchMedia', undefined)
    renderEvents()

    const nav = await screen.findByText('Severe weather')
    expect(() => fireEvent.click(nav)).not.toThrow()
  })
})
