import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// hunt-wave12-2026-08-30: the five visual controls (view distance, daylight
// strength, night strength, desaturation, ambient) all apply through the
// generic setClimateFloat(floatId, value) action, keyed by a hardcoded
// ClimateFloat id (desaturation=0, nightStrength=2, ambient=9,
// viewDistance=10, dayLightStrength=11 -- see PanelBridge.lua's
// handlers.getClimateFloats). tsc and eslint cannot catch a wrong id here:
// they're all plain numbers, the call still type-checks and still
// "succeeds" -- it would just silently drive the wrong effect (e.g. a
// desaturation slider that actually changes night strength). This pins the
// mapping so a future edit that transposes two ids fails loudly instead of
// shipping a control that lies about what it does.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      setClimateFloat: vi.fn(),
    },
  }
})

// Same stub as Events.climateFloatRanges.test.tsx -- Radix's Slider measures
// its own DOM node via ResizeObserver, which jsdom does not implement.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const setClimateFloat = vi.mocked(panelBridgeApi.setClimateFloat)

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

// Distinct, easy-to-tell-apart values per id -- if two ids were ever
// transposed, the wrong value would land on the wrong assertion too, not
// just the wrong id.
beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  setClimateFloat.mockReset().mockResolvedValue({ success: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({
    success: true,
    data: {
      floats: [
        { id: 0, name: 'FLOAT_DESATURATION', actualName: '', value: 0.11, min: 0, max: 1, isAdminEnabled: false },
        { id: 2, name: 'FLOAT_NIGHT_STRENGTH', actualName: '', value: 0.22, min: 0, max: 1, isAdminEnabled: false },
        { id: 9, name: 'FLOAT_AMBIENT', actualName: '', value: 0.33, min: 0, max: 1, isAdminEnabled: false },
        { id: 10, name: 'FLOAT_VIEW_DISTANCE', actualName: '', value: 0.44, min: 0, max: 1, isAdminEnabled: false },
        { id: 11, name: 'FLOAT_DAYLIGHT_STRENGTH', actualName: '', value: 0.55, min: 0, max: 1, isAdminEnabled: false },
      ],
    },
  } as never)
})

describe('Events -- visual controls pin each slider to its real ClimateFloat id', () => {
  it('Apply all sends setClimateFloat with the expected id for every one of the five controls', async () => {
    renderEvents()

    const visualNav = await screen.findByText('Visual rendering')
    visualNav.click()

    // Sliders mount with the values getClimateFloats reported (the same
    // poll the climate section already relies on) -- wait for them before
    // applying, so the assertions below are against real fetched state,
    // not the useState(0) seed.
    await waitFor(() => expect(screen.getAllByRole('slider')).toHaveLength(5))

    const applyButton = await screen.findByRole('button', { name: 'apply all' })
    applyButton.click()

    await waitFor(() => expect(setClimateFloat).toHaveBeenCalledTimes(5))

    expect(setClimateFloat).toHaveBeenCalledWith(10, 0.44) // viewDistance
    expect(setClimateFloat).toHaveBeenCalledWith(11, 0.55) // dayLight
    expect(setClimateFloat).toHaveBeenCalledWith(2, 0.22) // nightStrength
    expect(setClimateFloat).toHaveBeenCalledWith(0, 0.11) // desaturation
    expect(setClimateFloat).toHaveBeenCalledWith(9, 0.33) // ambient
  })
})
