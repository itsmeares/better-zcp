import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// 2026-08-30, panelbridge-audit-2026-08-30: vehicleSetSiren is a real,
// working, VERIFY_GATED Lua handler with no caller anywhere in the client --
// WorldMap.tsx renders live siren state (a flashing map halo) and Events.tsx
// shows a siren badge in this exact table, but only its two siblings in the
// same row (vehicleSetAlarm, vehicleSetTrunkLocked) ever had a button. This
// adds the missing one, matching them exactly (same row, same onInlineAction
// call shape, same permission/verify path -- no new pattern introduced).

// Same jsdom-Radix-Select workaround as Chat.capabilityGating.test.tsx and
// Players.capabilityGating.test.tsx: a real pointer interaction on a Radix
// Select throws in jsdom (hasPointerCapture/scrollIntoView missing). Swap the
// picker for a native <select>, which drives the exact same onValueChange.
vi.mock('@/components/ui/select', () => {
  function findAriaLabel(children: React.ReactNode): string | undefined {
    let found: string | undefined
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const label = (child.props as { 'aria-label'?: string })['aria-label']
      if (label) found = label
    })
    return found
  }
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, disabled, children }: { value: string; onValueChange: (v: string) => void; disabled?: boolean; children: React.ReactNode }) {
    return (
      <select
        aria-label={findAriaLabel(children)}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {collectItems(children).map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver
Element.prototype.scrollIntoView = vi.fn()

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
      sendCommand: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)

const VEHICLE = { id: 7, scriptName: 'Base.PickUpVan', x: 100, y: 200, batteryCharge: 0.8, alarmed: false, sirening: false, trunkLocked: true }

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

async function loadVehicleTable() {
  const nav = await screen.findByText('Bridge tools')
  fireEvent.click(nav)
  const combo = await screen.findByRole('combobox', { name: 'Select operation' })
  fireEvent.change(combo, { target: { value: 'getVehiclesDetailed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run Operation' }))
  // BridgeResultDisplay strips the "Base." prefix from scriptName before
  // rendering it (Events.tsx: `v.scriptName.replace('Base.', '')`).
  await screen.findByText('PickUpVan')
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  sendCommand.mockReset().mockImplementation((action: string) => {
    if (action === 'getVehiclesDetailed') {
      return Promise.resolve({ success: true, data: { vehicles: [VEHICLE] } } as never)
    }
    return Promise.resolve({ success: true, data: { verified: 'confirmed' } } as never)
  })
})

describe('Events -- vehicleSetSiren has a real UI control, matching its alarm/trunk-lock siblings', () => {
  it('renders a Siren On button next to Alarm/Trunk in the vehicle results row', async () => {
    renderEvents()
    await loadVehicleTable()

    expect(screen.getByRole('button', { name: 'Alarm On' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Siren On' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy()
  })

  it('calls vehicleSetSiren with the vehicle id and the toggled state when clicked', async () => {
    renderEvents()
    await loadVehicleTable()

    fireEvent.click(screen.getByRole('button', { name: 'Siren On' }))

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith('vehicleSetSiren', { vehicleId: 7, enabled: true })
    })
  })
})
