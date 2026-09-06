import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// 5aaf2c3e (2026-08-02) made panelBridge.js's /utilities/restore and
// /utilities/shutoff routes merge persistUtilities()'s (Node-side, writes
// SandboxVars.lua directly) `{ persisted, persistReason }` into the JSON
// response alongside the Lua handler's own result -- so a real "this will
// not survive a server restart" signal has been on the wire since then.
// 2d7cca63 (2026-08-30, "Finding C") deleted the client's warning for this,
// on an analysis that checked only the Lua handler's raw result object
// (which indeed never carries these fields) instead of the route's merged
// response the client actually receives -- right observation, wrong
// producer -- and left behind a test asserting the field is ignored. That
// test is Events.utilitiesPersistedDeadFieldRemoved.test.tsx, replaced by
// this file. These fixtures use the ROUTE's real merged response shape
// (Lua fields alongside persisted/persistReason, exactly as
// `res.json({ ...result, ...(await persistUtilities(...)) })` produces it)
// so a future audit that looks only at the Lua handler cannot conclude
// again that this warning is unreachable.

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
  // 2026-08-31 (paired-buttons operator request): the Power/Water controls
  // are now a single Switch reflecting utilitiesStatus.powerOn/waterOn, and
  // the switch disables itself while that state is unknown -- so this test
  // (which only cares about the toast on the ACTION's own response) needs a
  // real, resolved status here to make the switch interactable at all.
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
    // Route's real merged shape: the Lua handler's own fields
    // (success/message/power/water/hydroPowerOn/debug) plus persistUtilities()'s
    // { persisted, persistReason } spread on top -- never a bare
    // { persisted: false } by itself.
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
