import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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
      setSnow: vi.fn(),
      stopWeather: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const getWeather = vi.mocked(panelBridgeApi.getWeather)
const setSnow = vi.mocked(panelBridgeApi.setSnow)

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
  await screen.findByText('Blizzards, tropical storms, and snowfall.')
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  setSnow.mockReset().mockResolvedValue({ success: true } as never)
})

function snowSwitch() {
  return screen.findByRole('switch', { name: 'snow toggle' })
}

describe('Events -- Severe Weather snow toggle reflects real state (three states)', () => {
  it('ON: renders checked when liveWeather.isSnowing is true, and clicking disables snow', async () => {
    getWeather.mockResolvedValue({
      success: true,
      data: { isRaining: false, isSnowing: true, isThunderStorming: false, windSpeed: 0, windAngle: 0 },
    } as never)

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
    expect(sw).toBeEnabled()

    sw.click()
    await waitFor(() => expect(setSnow).toHaveBeenCalledWith(false))
  })

  it('OPTIMISTIC: flips immediately on click (does not wait for the next poll), then reverts if the command fails', async () => {
    getWeather.mockResolvedValue({
      success: true,
      data: { isRaining: false, isSnowing: false, isThunderStorming: false, windSpeed: 0, windAngle: 0 },
    } as never)

    let rejectSetSnow!: (err: Error) => void
    setSnow.mockReturnValue(new Promise((_, reject) => { rejectSetSnow = reject }))

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))

    sw.click()

    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))

    rejectSetSnow(new Error('bridge command failed'))

    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))
  })

  it('RECONCILE: refetches the real weather after a successful command, and the real answer wins over the optimistic guess', async () => {
    getWeather.mockResolvedValue({
      success: true,
      data: { isRaining: false, isSnowing: false, isThunderStorming: false, windSpeed: 0, windAngle: 0 },
    } as never)
    setSnow.mockResolvedValue({ success: true } as never)

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))

    sw.click()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
    await waitFor(() => expect(setSnow).toHaveBeenCalledWith(true))
    const callsBeforeReconcile = getWeather.mock.calls.length

    await waitFor(() => expect(getWeather.mock.calls.length).toBeGreaterThan(callsBeforeReconcile))
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))
  })

  it('OFF: renders unchecked when liveWeather.isSnowing is false, and clicking enables snow', async () => {
    getWeather.mockResolvedValue({
      success: true,
      data: { isRaining: false, isSnowing: false, isThunderStorming: false, windSpeed: 0, windAngle: 0 },
    } as never)

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))
    expect(sw).toBeEnabled()

    sw.click()
    await waitFor(() => expect(setSnow).toHaveBeenCalledWith(true))
  })

  it('UNKNOWN: renders disabled and unchecked (not a faked "off") when getWeather fails, and never calls setSnow', async () => {
    getWeather.mockResolvedValue({ success: false } as never)

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    await waitFor(() => expect(sw).toBeDisabled())
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(screen.getAllByText('…').length).toBeGreaterThan(0)

    sw.click()
    expect(setSnow).not.toHaveBeenCalled()
  })

  it('UNKNOWN: renders disabled before getWeather resolves at all (pending, not yet failed)', async () => {
    getWeather.mockReturnValue(new Promise(() => {}))

    renderEvents()
    await openSevereSection()

    const sw = await snowSwitch()
    expect(sw).toBeDisabled()
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })
})
