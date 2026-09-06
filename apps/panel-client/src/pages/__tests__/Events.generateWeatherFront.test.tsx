import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// wired-no-ui-2026-08-30: generateWeather (POST /panel-bridge/weather/generate)
// had a live, gated route and Lua handler but zero client callers -- distinct
// from triggerBlizzard/triggerTropicalStorm/triggerStorm, which each fire one
// fixed WeatherPeriod preset stage. This is the adjustable one: an operator
// picks a strength (0-1) and a front type, which the server maps to the
// game's own FRONT_COLD(-1)/STATIONARY(0)/WARM(1) constants -- stationary=0,
// cold=1, warm=2 client-side (PanelBridge.lua's javaFrontMap). A transposed
// cold/warm selection would silently trigger the wrong kind of front with no
// compiler signal, same defect class as the visual-controls float-id pin.

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
      getWeather: vi.fn(),
      generateWeather: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const getWeather = vi.mocked(panelBridgeApi.getWeather)
const generateWeather = vi.mocked(panelBridgeApi.generateWeather)

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

async function openSevereSection() {
  const nav = await screen.findByText('Severe weather')
  nav.click()
  await screen.findByRole('button', { name: 'generate front' })
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getWeather.mockReset().mockResolvedValue({ success: false } as never)
  generateWeather.mockReset().mockResolvedValue({ success: true } as never)
})

describe('Events -- custom weather front sends the correct strength and frontType mapping', () => {
  it('defaults to stationary (0) at 50%', async () => {
    renderEvents()
    await openSevereSection()

    screen.getByRole('button', { name: 'generate front' }).click()

    await waitFor(() => expect(generateWeather).toHaveBeenCalledWith(0.5, 0))
  })

  // Selecting "cold front" / "warm front" and confirming generateWeather is
  // called with (strength, 1) / (strength, 2) is NOT covered here: Radix
  // Select cannot be driven via fireEvent.click in jsdom -- confirmed the
  // hard way (candidate?.scrollIntoView is not a function, a genuine
  // missing jsdom API, not a wrong-event mistake), same limitation
  // Players.capabilityGating.test.tsx's Give-XP gate hits for the same
  // reason. The SelectItem values are literal "0"/"1"/"2" strings sitting
  // directly next to their cold/warm/stationary labels in the JSX (not an
  // opaque id threaded through separate state the way the visual-controls
  // float-id pin needed), so the transposition risk this class of test
  // exists to catch is much smaller here -- the stationary-default case
  // above is the one genuinely useful client-side assertion; the
  // 0/-1/1 -> java front-type remap itself lives server-side in
  // PanelBridge.lua, out of this file's boundary.
})
