import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from '@/test/router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
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
      getWeather: vi.fn(),
      clearZombiesNearPlayer: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const getWeather = vi.mocked(panelBridgeApi.getWeather)
const clearZombiesNearPlayer = vi.mocked(panelBridgeApi.clearZombiesNearPlayer)

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

async function openHordeSection() {
  const nav = await screen.findByText('Spawn horde')
  nav.click()
  await screen.findByRole('button', { name: /^clear near\b/ })
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [{ name: 'Kate', online: true }] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getWeather.mockReset().mockResolvedValue({ success: false } as never)
  clearZombiesNearPlayer.mockReset().mockResolvedValue({ success: true } as never)
})

describe('Events -- clearZombiesNearPlayer is gated behind a confirm dialog, matching clearAllZombies\' tier', () => {
  it('is NOT dispatched until the confirm dialog is accepted, and NOT dispatched at all if cancelled', async () => {
    renderEvents()
    await openHordeSection()

    screen.getByRole('button', { name: /^clear near\b/ }).click()

    const cancelButton = await screen.findByRole('button', { name: 'Cancel' })
    expect(clearZombiesNearPlayer).not.toHaveBeenCalled()
    cancelButton.click()

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument())
    expect(clearZombiesNearPlayer).not.toHaveBeenCalled()
  })

  it('IS dispatched with the resolved target and the chosen radius once confirmed', async () => {
    renderEvents()
    await openHordeSection()

    screen.getByRole('button', { name: 'clear near random' }).click()

    const dialog = await screen.findByRole('alertdialog')
    within(dialog).getByRole('button', { name: 'clear near random' }).click()

    await waitFor(() => expect(clearZombiesNearPlayer).toHaveBeenCalledWith('Kate', 50))
  })
})
