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
const restoreUtilities = vi.mocked(panelBridgeApi.restoreUtilities)
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

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  restoreUtilities.mockReset()
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

describe('Events -- utilities status surfaces the computed shutoff reasoning, not just on/off', () => {
  it('renders the modifier/day/nights-survived inputs behind powerOn/waterOn, including the documented never-shuts-off sentinel', async () => {
    renderEvents()
    await openUtilitiesSection()

    await screen.findByText('modifier 15 · world day 3 · 2 nights survived')
    await screen.findByText('modifier never · world day 3 · 2 nights survived')
  })
})

describe('Events -- a utilities action that silently does not take effect is reported, not shown as success', () => {
  it('shows a failure toast when shutOffUtilities claims success but the hydroPowerOn read-back still reports power on', async () => {
    shutOffUtilities.mockResolvedValue({
      success: true,
      message: 'Utilities shut off',
      power: true,
      water: false,
      hydroPowerOn: true, // the write didn't stick -- still on
      debug: ['FINAL isHydroPowerOn=true'],
    } as never)

    renderEvents()
    await openUtilitiesSection()

    const switches = await screen.findAllByRole('switch', { name: /power|water/i })
    switches[0].click()

    await waitFor(() => expect(shutOffUtilities).toHaveBeenCalledWith(true, false))
    await waitFor(() => {
      const call = toastSpy.mock.calls.find((c) => c[0]?.variant === 'destructive')
      expect(call, 'expected a destructive toast reporting the mismatch').toBeTruthy()
      expect(call?.[0].description).toMatch(/still online/i)
    })
  })

  it('shows the normal success toast when the read-back confirms power actually turned off as requested', async () => {
    shutOffUtilities.mockResolvedValue({
      success: true,
      message: 'Utilities shut off',
      power: true,
      water: false,
      hydroPowerOn: false, // matches the requested state
      debug: ['FINAL isHydroPowerOn=false'],
    } as never)

    renderEvents()
    await openUtilitiesSection()

    const switches = await screen.findAllByRole('switch', { name: /power|water/i })
    switches[0].click()

    await waitFor(() => expect(shutOffUtilities).toHaveBeenCalledWith(true, false))
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalled()
      const call = toastSpy.mock.calls.at(-1)
      expect(call?.[0].variant).toBe('success')
    })
  })

  it('shows the normal success toast for a water-only shutoff regardless of hydroPowerOn -- water has no equivalent read-back to compare against', async () => {
    shutOffUtilities.mockResolvedValue({
      success: true,
      message: 'Utilities shut off',
      power: false,
      water: true,
      hydroPowerOn: true, // untouched by a water-only request -- must not be misread as a power mismatch
      debug: ['FINAL isHydroPowerOn=true'],
    } as never)

    renderEvents()
    await openUtilitiesSection()

    const switches = await screen.findAllByRole('switch', { name: /power|water/i })
    switches[1].click()

    await waitFor(() => expect(shutOffUtilities).toHaveBeenCalledWith(false, true))
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalled()
      const call = toastSpy.mock.calls.at(-1)
      expect(call?.[0].variant).toBe('success')
    })
  })
})
