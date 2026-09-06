import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// bug-hunt-2026-08-26, card utilities-shutoff-reasoning-is-computed-and-
// discarded (#8/46): PanelBridge.lua's getUtilitiesStatus replicates the
// game's own power formula (ISButtonPrompt.lua:421) and returns the
// modifier/day/nights-survived inputs behind powerOn/waterOn -- the server
// forwards the whole payload unmodified, but Events.tsx only read 3 of the
// ~7 fields (hydroPowerOn/powerOn/waterOn) and rendered nothing but a
// binary on/off dot, discarding the rest.
//
// Separately: restoreUtilities/shutOffUtilities already return a genuine
// post-action hydroPowerOn read-back (the b376b2c-family fix -- see
// panelBridgeUtilitiesHydroPowerOnReporting.test.js), but the client never
// compared it to the requested state, so a write that silently didn't
// stick (the Lua's own comments describe exactly this risk: "applySettings
// can re-roll the modifier") still produced a plain success toast -- the
// same "action silently does not happen, reason already computed and
// discarded" shape as Jim's template-apply fix.

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

// Radix primitives mounted elsewhere on this page measure via ResizeObserver,
// which jsdom does not implement -- matches Events.climateFloatRanges.test.tsx.
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
  // Sublabel text unique to the mounted utilities section -- confirms the
  // panel actually swapped in before proceeding.
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

    // Power: real modifier value shown as-is.
    await screen.findByText('modifier 15 · world day 3 · 2 nights survived')
    // Water: 2147483647 is PanelBridge.lua's own documented "never shuts
    // off" sentinel -- shown as a word, not the raw 32-bit max literal.
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

    // The utilities Power/Water controls are now a single state-reflecting
    // Switch each (2026-08-31, paired-buttons operator request), not a
    // Restore/Shut Off button pair -- both mock powerOn/waterOn true in
    // beforeEach, so the switches render checked; clicking flips them off.
    const switches = await screen.findAllByRole('switch', { name: /power|water/i })
    switches[0].click() // power row renders first

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
    switches[1].click() // water row renders second

    await waitFor(() => expect(shutOffUtilities).toHaveBeenCalledWith(false, true))
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalled()
      const call = toastSpy.mock.calls.at(-1)
      expect(call?.[0].variant).toBe('success')
    })
  })
})
