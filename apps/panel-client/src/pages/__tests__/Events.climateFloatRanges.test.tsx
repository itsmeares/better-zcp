import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// bug-hunt-2026-08-26: getClimateFloats() reports each ClimateFloat's real,
// server-authoritative min/max (PanelBridge.lua handlers.getClimateFloats ->
// cf:getMin()/cf:getMax()), and the route/api layer passed it through
// untouched. Events.tsx fetched the response, read only `.value` off each
// float, and bound every climate slider to a hardcoded range (0-100 for the
// five percent-style floats, -30..45 for temperature) instead. A hardcoded
// range that is too wide lets an operator request a value the game will
// never honour; too narrow hides a legitimate one -- either way the UI lies
// about what is possible using data it already has on the wire. This test
// renders the real Climate trim sliders against a distinctive non-default
// range and pins that the rendered bounds come from the wire, not from the
// old hardcoded constants.

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
      sendCommand: vi.fn(),
    },
  }
})

// Radix's Slider measures its own DOM node via ResizeObserver, which jsdom does not
// implement. No production code depends on real measurements here -- a stub is enough
// for the slider to mount and report its min/max/value via ARIA attributes.
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

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({
    modConnected: true,
  } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  sendCommand.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({
    success: true,
    data: {
      floats: [
        { id: 3, name: 'FLOAT_PRECIPITATION_INTENSITY', actualName: '', value: 0, min: 0.1, max: 0.7, isAdminEnabled: false },
        { id: 4, name: 'FLOAT_TEMPERATURE', actualName: '', value: 20, min: -10, max: 35, isAdminEnabled: false },
        { id: 5, name: 'FLOAT_FOG_INTENSITY', actualName: '', value: 0.3, min: 0.2, max: 0.6, isAdminEnabled: false },
        { id: 6, name: 'FLOAT_WIND_INTENSITY', actualName: '', value: 0, min: 0, max: 0.8, isAdminEnabled: false },
        { id: 8, name: 'FLOAT_CLOUD_INTENSITY', actualName: '', value: 0, min: 0.05, max: 0.9, isAdminEnabled: false },
        { id: 12, name: 'FLOAT_HUMIDITY', actualName: '', value: 0.5, min: 0.15, max: 0.85, isAdminEnabled: false },
      ],
    },
  } as never)
})

// Radix's Slider Thumb only gets an accessible name from the multi-thumb
// "Minimum"/"Maximum"/"Value N of M" convention (see getLabel() in
// @radix-ui/react-slider) -- the `aria-label` prop on our <Slider> wrapper
// lands on the outer (non-role) container, not the role="slider" Thumb, so
// it is not queryable by accessible name. Index into the climate section's
// sliders by their fixed JSX order instead: fog, wind, temperature, clouds,
// humidity, precipitation. Only one section's controls are ever mounted at
// a time (each is behind `{activeSection === 'x' && (...)}`), so this is
// exactly the six climate sliders once the Climate trim section is active.
const CLIMATE_SLIDER_ORDER = ['fog', 'wind', 'temperature', 'clouds', 'humidity', 'precipitation'] as const

async function getClimateSliders() {
  const climateNav = await screen.findByText('Climate trim')
  climateNav.click()
  const sliders = await waitFor(() => {
    const found = screen.getAllByRole('slider')
    expect(found).toHaveLength(CLIMATE_SLIDER_ORDER.length)
    return found
  })
  return Object.fromEntries(CLIMATE_SLIDER_ORDER.map((name, i) => [name, sliders[i]])) as Record<
    (typeof CLIMATE_SLIDER_ORDER)[number],
    HTMLElement
  >
}

describe('Events -- climate sliders bind to the real per-float range, not a hardcoded one', () => {
  it('binds each climate slider to the min/max getClimateFloats reports on the wire', async () => {
    renderEvents()

    const { fog, wind, temperature, clouds, humidity, precipitation } = await getClimateSliders()

    await waitFor(() => expect(fog).toHaveAttribute('aria-valuemax', '60'))
    expect(fog).toHaveAttribute('aria-valuemin', '20')

    expect(wind).toHaveAttribute('aria-valuemin', '0')
    expect(wind).toHaveAttribute('aria-valuemax', '80')

    expect(temperature).toHaveAttribute('aria-valuemin', '-10')
    expect(temperature).toHaveAttribute('aria-valuemax', '35')

    expect(clouds).toHaveAttribute('aria-valuemin', '5')
    expect(clouds).toHaveAttribute('aria-valuemax', '90')

    expect(humidity).toHaveAttribute('aria-valuemin', '15')
    expect(humidity).toHaveAttribute('aria-valuemax', '85')

    expect(precipitation).toHaveAttribute('aria-valuemin', '10')
    expect(precipitation).toHaveAttribute('aria-valuemax', '70')
  })

  it('falls back to the old default range before the bridge has reported real bounds', async () => {
    getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)

    renderEvents()

    const { fog, temperature } = await getClimateSliders()

    expect(fog).toHaveAttribute('aria-valuemin', '0')
    expect(fog).toHaveAttribute('aria-valuemax', '100')

    expect(temperature).toHaveAttribute('aria-valuemin', '-30')
    expect(temperature).toHaveAttribute('aria-valuemax', '45')
  })
})
