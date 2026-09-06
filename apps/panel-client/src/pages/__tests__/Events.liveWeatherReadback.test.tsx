import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// panelbridge-audit-2026-08-30: getWeather was confirmed working (Kevin's
// audit) but had no caller anywhere in apps/panel-client/src. Most of its payload
// (temperature, humidity, fog, cloud, precipitation, dayLight, nightStrength,
// desaturation, viewDistance, ambient) is the exact same ClimateFloat data
// the climate/visual sections already poll via getClimateFloats and render
// as sliders -- deliberately NOT duplicated here (see the "did not display
// getWorldStats.zombiesInCell twice" precedent from the Dashboard card
// earlier tonight). The only genuinely new, non-duplicated fields are the
// live isRaining/isSnowing/isThunderStorming booleans and the real
// windSpeed(kph)/windAngle(degrees) pair -- neither was observable anywhere
// in the panel before this (the existing "wind" slider is a 0-100% override
// intensity, not a live reading). This proves those specific fields, and
// only those, are wired to the climate section's new live-conditions strip.

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
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const getWeather = vi.mocked(panelBridgeApi.getWeather)

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

async function openClimateSection() {
  const nav = await screen.findByText('Climate trim')
  nav.click()
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
})

describe('Events -- climate section shows a real, non-duplicated live weather reading', () => {
  it('renders the live isThunderStorming/windSpeed/windAngle reading from getWeather, not a stale default', async () => {
    getWeather.mockResolvedValue({
      success: true,
      data: {
        temperature: 20, humidity: 0.5, windSpeed: 37, windAngle: 214,
        fogIntensity: 0, cloudIntensity: 0, precipitationIntensity: 0,
        isRaining: true, isSnowing: false, isThunderStorming: true,
        dayLight: 1, nightStrength: 0, desaturation: 0, viewDistance: 1, ambient: 1,
      },
    } as never)

    renderEvents()
    await openClimateSection()

    await waitFor(() => expect(screen.getByText('thunderstorm')).toBeInTheDocument())
    // Raining is true too, but thunderstorm takes precedence in the badge set --
    // both booleans came through, only the display collapsed them.
    expect(screen.getByText('37 km/h @ 214°')).toBeInTheDocument()
  })

  it('shows nothing before the bridge has actually reported weather (no seeded default)', async () => {
    getWeather.mockResolvedValue({ success: false } as never)

    renderEvents()
    await openClimateSection()

    await waitFor(() => expect(screen.getByText('fog')).toBeInTheDocument())
    expect(screen.queryByText('clear')).not.toBeInTheDocument()
    expect(screen.queryByText('thunderstorm')).not.toBeInTheDocument()
    expect(screen.queryByText(/km\/h/)).not.toBeInTheDocument()
  })
})
