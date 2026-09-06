import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// 2026-08-30, panelbridge-total-audit-2026-08-30 (Finding D): the safehouse
// "Add Player" button read `players[0]?.name` -- the first entry of the
// whole server's online-player list, not a player the admin chose for this
// safehouse. It silently added whoever happened to be first, disclosed only
// after the fact in the toast. This test asserts the admin must pick a
// player before the button does anything.

// Same jsdom-Radix-Select workaround as Events.vehicleSirenControl.test.tsx:
// a real pointer interaction on a Radix Select throws in jsdom. Swap the
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

const SAFEHOUSE = { id: 'sh-1', title: 'North Camp', owner: 'Alice', players: ['Alice'] }
const ONLINE_PLAYERS = [{ name: 'Zed' }, { name: 'Bob' }, { name: 'Carol' }]

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

async function loadSafehouseList() {
  const nav = await screen.findByText('Bridge tools')
  fireEvent.click(nav)
  const combo = await screen.findByRole('combobox', { name: 'Select operation' })
  fireEvent.change(combo, { target: { value: 'getSafehouses' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run Operation' }))
  await screen.findByText('North Camp')
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: ONLINE_PLAYERS } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  sendCommand.mockReset().mockImplementation((action: string) => {
    if (action === 'getSafehouses') {
      return Promise.resolve({ success: true, data: { safehouses: [SAFEHOUSE] } } as never)
    }
    return Promise.resolve({ success: true, data: { verified: 'confirmed' } } as never)
  })
})

describe('Events -- safehouse Add Player requires an explicit selection (Finding D)', () => {
  it('does not call safehouseAddPlayer with the first online player when nothing is selected', async () => {
    renderEvents()
    await loadSafehouseList()

    const addButton = screen.getByRole('button', { name: '+ Player' })
    fireEvent.click(addButton)

    // Give any accidental async call a chance to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sendCommand).not.toHaveBeenCalledWith('safehouseAddPlayer', expect.anything())
  })

  it('calls safehouseAddPlayer with the admin-selected player, not players[0]', async () => {
    renderEvents()
    await loadSafehouseList()

    const picker = screen.getByRole('combobox', { name: 'Player to add to North Camp' })
    fireEvent.change(picker, { target: { value: 'Carol' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Player' }))

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith('safehouseAddPlayer', { safehouseRef: 'sh-1', username: 'Carol' })
    })
    // Zed is players[0] in ONLINE_PLAYERS -- the old bug would have added him regardless of selection.
    expect(sendCommand).not.toHaveBeenCalledWith('safehouseAddPlayer', { safehouseRef: 'sh-1', username: 'Zed' })
  })
})
