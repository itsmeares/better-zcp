import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from '@/lib/routerCompat'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'


const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

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
      restoreUtilities: vi.fn(),
      shutOffUtilities: vi.fn(),
      sendCommand: vi.fn(),
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
const shutOffUtilities = vi.mocked(panelBridgeApi.shutOffUtilities)
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

async function openUtilitiesSection() {
  const nav = await screen.findByText('Power and water')
  nav.click()
  await screen.findByText('power & water grid')
}

async function toggleFirstSwitch() {
  const switches = await screen.findAllByRole('switch', { name: /power|water/i })
  switches[0].click()
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  shutOffUtilities.mockReset()
  sendCommand.mockReset().mockResolvedValue({ success: false } as never)
  toastSpy.mockReset()
  getUtilitiesStatus.mockReset().mockResolvedValue({
    success: true,
    data: {
      hydroPowerOn: true,
      powerOn: true,
      waterOn: true,
      elecShut: '1',
      waterShut: '9',
      elecShutModifier: 15,
      waterShutModifier: 2147483647,
      currentWorldDay: 3.7,
      nightsSurvived: 2,
    },
  } as never)
})

describe('Events -- the utilities persist-failure warning (restored, was wrongly deleted in 2d7cca63)', () => {
  it('warns, with the reason, when the route reports persisted: false', async () => {
    shutOffUtilities.mockResolvedValue({
      success: true,
      message: 'Utilities shut off',
      power: true,
      water: false,
      hydroPowerOn: false, // matches the requested state -- no power mismatch
      debug: ['FINAL isHydroPowerOn=false'],
      persisted: false,
      persistReason: 'SandboxVars write did not stick',
    } as never)

    renderEvents()
    await openUtilitiesSection()
    await toggleFirstSwitch()

    await waitFor(() => expect(shutOffUtilities).toHaveBeenCalledWith(true, false))
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalled()
      const call = toastSpy.mock.calls.at(-1)
      expect(call?.[0].variant).toBe('default')
      expect(call?.[0].description).toMatch(/SandboxVars write did not stick/)
    })
  })

  it('falls back to an "unknown reason" copy when persistReason is missing', async () => {
    shutOffUtilities.mockResolvedValue({
      success: true,
      message: 'Utilities shut off',
      power: true,
      water: false,
      hydroPowerOn: false,
      debug: ['FINAL isHydroPowerOn=false'],
      persisted: false,
      persistReason: null,
    } as never)

    renderEvents()
    await openUtilitiesSection()
    await toggleFirstSwitch()

    await waitFor(() => expect(shutOffUtilities).toHaveBeenCalledWith(true, false))
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalled()
      const call = toastSpy.mock.calls.at(-1)
      expect(call?.[0].variant).toBe('default')
      expect(call?.[0].description).toMatch(/unknown reason/i)
    })
  })

  it('shows the ordinary success toast when the route reports persisted: true', async () => {
    shutOffUtilities.mockResolvedValue({
      success: true,
      message: 'Utilities shut off',
      power: true,
      water: false,
      hydroPowerOn: false,
      debug: ['FINAL isHydroPowerOn=false'],
      persisted: true,
      persistReason: null,
    } as never)

    renderEvents()
    await openUtilitiesSection()
    await toggleFirstSwitch()

    await waitFor(() => expect(shutOffUtilities).toHaveBeenCalledWith(true, false))
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalled()
      const call = toastSpy.mock.calls.at(-1)
      expect(call?.[0].variant).toBe('success')
      expect(call?.[0].description).not.toMatch(/SandboxVars|persist/i)
    })
  })
})
