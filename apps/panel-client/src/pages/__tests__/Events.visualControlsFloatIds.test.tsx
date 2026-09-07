import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from '@/test/router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'


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

    await waitFor(() => expect(screen.getAllByRole('slider')).toHaveLength(5))

    const applyButton = await screen.findByRole('button', { name: 'apply all' })
    applyButton.click()

    await waitFor(() => expect(setClimateFloat).toHaveBeenCalledTimes(5))

    expect(setClimateFloat).toHaveBeenCalledWith(10, 0.44)
    expect(setClimateFloat).toHaveBeenCalledWith(11, 0.55)
    expect(setClimateFloat).toHaveBeenCalledWith(2, 0.22)
    expect(setClimateFloat).toHaveBeenCalledWith(0, 0.11)
    expect(setClimateFloat).toHaveBeenCalledWith(9, 0.33)
  })
})
