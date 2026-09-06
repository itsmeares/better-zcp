import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SpawnBrowser } from '../SpawnBrowser'
import { panelBridgeApi } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getCatalogItems: vi.fn(),
      getCatalogVehicles: vi.fn(),
      scanCatalogItems: vi.fn(),
      scanCatalogVehicles: vi.fn(),
    },
  }
})

const getCatalogItems = vi.mocked(panelBridgeApi.getCatalogItems)
const getCatalogVehicles = vi.mocked(panelBridgeApi.getCatalogVehicles)

// jsdom doesn't implement scrollIntoView; the row-highlight effect calls it.
Element.prototype.scrollIntoView = vi.fn()

const ITEMS = [
  { id: 'Base.Axe', name: 'Axe', category: 'WeaponPrimitive', weight: 3 },
  { id: 'Base.EmpanadaCafe', name: 'Café Empañada', category: 'Food', weight: 0.3 },
]
const VEHICLES = [
  { id: 'Base.CarNormal', name: 'Générique Berline', mass: 1200, seats: 4 },
]

beforeEach(() => {
  getCatalogItems.mockReset().mockResolvedValue({ items: ITEMS, count: ITEMS.length, scannedAt: null })
  getCatalogVehicles.mockReset().mockResolvedValue({ vehicles: VEHICLES, count: VEHICLES.length, scannedAt: null })
  localStorage.clear()
})

async function renderItems(props: Partial<{ playerName: string; onSpawn: (id: string, qty?: number) => Promise<void> }> = {}) {
  const onSpawn = props.onSpawn || vi.fn().mockResolvedValue(undefined)
  render(
    <SpawnBrowser mode="items" open onOpenChange={vi.fn()} playerName={props.playerName ?? ''} onSpawn={onSpawn} />
  )
  await screen.findByText('Café Empañada')
  return { onSpawn }
}

describe('SpawnBrowser -- items (Give)', () => {
  it('Give is disabled with no player selected, even after picking an item', async () => {
    await renderItems({ playerName: '' })
    fireEvent.click(screen.getByText('Café Empañada'))
    expect(screen.getByRole('button', { name: /^Give/ })).toBeDisabled()
  })

  it('does not silently give to nobody: double-clicking a row with no player selected does not call onSpawn', async () => {
    const { onSpawn } = await renderItems({ playerName: '' })
    fireEvent.doubleClick(screen.getByText('Café Empañada'))
    await new Promise((r) => setTimeout(r, 0))
    expect(onSpawn).not.toHaveBeenCalled()
  })

  it('Give is enabled once a player is selected and calls onSpawn with the real id and quantity', async () => {
    const { onSpawn } = await renderItems({ playerName: 'Aurélie' })
    fireEvent.click(screen.getByText('Café Empañada'))
    const giveBtn = screen.getByRole('button', { name: /^Give/ })
    expect(giveBtn).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }))
    fireEvent.click(giveBtn)

    await waitFor(() => expect(onSpawn).toHaveBeenCalledWith('Base.EmpanadaCafe', 2))
  })

  it('quantity cannot go below 1 or above 100', async () => {
    const { onSpawn } = await renderItems({ playerName: 'Aurélie' })
    const qtyInput = screen.getByRole('spinbutton', { name: 'Quantity' })
    expect(screen.getByRole('button', { name: 'Decrease quantity' })).toBeDisabled()

    fireEvent.change(qtyInput, { target: { value: '999' } })
    expect(qtyInput).toHaveValue(100)

    // Clearing/breaking the field mid-edit must show exactly what's there (empty),
    // never silently snap the visible field back to a default under the operator's
    // cursor -- and the underlying qty used for Give must hold its last valid value
    // (100), not corrupt to NaN, since nothing downstream sanitizes it before it
    // reaches the RCON give-item command.
    fireEvent.change(qtyInput, { target: { value: 'not a number' } })
    expect(qtyInput).toHaveValue(null)

    fireEvent.click(screen.getByText('Café Empañada'))
    fireEvent.click(screen.getByRole('button', { name: /^Give/ }))
    await waitFor(() => expect(onSpawn).toHaveBeenCalledWith('Base.EmpanadaCafe', 100))
  })

  it('a successful give adds a Recent entry and persists it across the mode-specific localStorage key', async () => {
    const onSpawn = vi.fn().mockResolvedValue(undefined)
    await renderItems({ playerName: 'Aurélie', onSpawn })
    fireEvent.click(screen.getByText('Café Empañada'))
    fireEvent.click(screen.getByRole('button', { name: /^Give/ }))

    await waitFor(() => expect(screen.getByTitle('Spawn Café Empañada × 1 again')).toBeInTheDocument())
    const stored = JSON.parse(localStorage.getItem('pz-spawn-recent-items')!)
    expect(stored[0]).toMatchObject({ id: 'Base.EmpanadaCafe', name: 'Café Empañada', qty: 1 })
  })

  it('a Recent entry is also disabled with no player selected -- the guard applies to the shortcut too', async () => {
    localStorage.setItem('pz-spawn-recent-items', JSON.stringify([{ id: 'Base.Axe', name: 'Axe', qty: 3, at: Date.now() }]))
    await renderItems({ playerName: '' })
    expect(screen.getByTitle('Spawn Axe × 3 again')).toBeDisabled()
  })

  it('keeps long Recent history in a bounded scroller and can clear only the item history', async () => {
    const itemHistory = Array.from({ length: 8 }, (_, index) => ({
      id: `Base.Item${index}`,
      name: `Very long recent item name ${index}`,
      qty: index + 1,
      at: Date.now() - index,
    }))
    const vehicleHistory = [{ id: 'Base.CarNormal', name: 'Générique Berline', qty: 1, at: Date.now() }]
    localStorage.setItem('pz-spawn-recent-items', JSON.stringify(itemHistory))
    localStorage.setItem('pz-spawn-recent-vehicles', JSON.stringify(vehicleHistory))

    await renderItems({ playerName: 'Aurélie' })

    expect(screen.getByRole('dialog')).toHaveClass('min-w-0')
    const recentGroup = screen.getByRole('group', { name: 'Recent' })
    expect(recentGroup).toHaveClass('min-w-0')
    expect(recentGroup.querySelector('[data-slot="recent-history-scroll"]')).toHaveClass(
      'min-w-0',
      'flex-1',
      'overflow-x-auto',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear recent history' }))

    expect(screen.queryByRole('group', { name: 'Recent' })).not.toBeInTheDocument()
    expect(localStorage.getItem('pz-spawn-recent-items')).toBeNull()
    expect(JSON.parse(localStorage.getItem('pz-spawn-recent-vehicles')!)).toEqual(vehicleHistory)
  })
})

describe('SpawnBrowser -- vehicles (Spawn)', () => {
  it('Spawn works with no player selected -- vehicles do not require a target', async () => {
    const onSpawn = vi.fn().mockResolvedValue(undefined)
    render(<SpawnBrowser mode="vehicles" open onOpenChange={vi.fn()} playerName="" onSpawn={onSpawn} />)
    await screen.findByText('Générique Berline')

    fireEvent.click(screen.getByText('Générique Berline'))
    fireEvent.click(screen.getByRole('button', { name: 'Spawn' }))

    await waitFor(() => expect(onSpawn).toHaveBeenCalledWith('Base.CarNormal', undefined))
  })

  it('clears the vehicle Recent history from its own storage key', async () => {
    localStorage.setItem('pz-spawn-recent-vehicles', JSON.stringify([
      { id: 'Base.CarNormal', name: 'Générique Berline', qty: 1, at: Date.now() },
    ]))
    render(<SpawnBrowser mode="vehicles" open onOpenChange={vi.fn()} playerName="" onSpawn={vi.fn()} />)
    await screen.findByText('Générique Berline')

    fireEvent.click(screen.getByRole('button', { name: 'Clear recent history' }))

    expect(screen.queryByRole('group', { name: 'Recent' })).not.toBeInTheDocument()
    expect(localStorage.getItem('pz-spawn-recent-vehicles')).toBeNull()
  })
})
