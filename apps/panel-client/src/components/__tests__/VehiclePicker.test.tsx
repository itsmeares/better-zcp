import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VehiclePicker, type CatalogVehicle, getVehicleType } from '../VehiclePicker'
import { panelBridgeApi } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getCatalogVehicles: vi.fn(),
      scanCatalogVehicles: vi.fn(),
    },
  }
})

const getCatalogVehicles = vi.mocked(panelBridgeApi.getCatalogVehicles)

const VEHICLES: CatalogVehicle[] = [
  { id: 'Base.CarNormal', name: 'Générique Berline', mass: 1200, seats: 4 },
  { id: 'Base.PoliceCruiser', name: 'Police Cruiser', mass: 1600, seats: 4 },
  { id: 'Base.VanAmbulance', name: 'Ambulance', mass: 2200, seats: 2 },
]

beforeEach(() => {
  getCatalogVehicles.mockReset()
})

async function renderPicker(props: Partial<{ value: string; onChange: (v: string) => void }> = {}) {
  getCatalogVehicles.mockResolvedValue({ vehicles: VEHICLES, count: VEHICLES.length, scannedAt: null })
  const onChange = props.onChange || vi.fn()
  render(<VehiclePicker value={props.value ?? ''} onChange={onChange} />)
  await waitFor(() => expect(getCatalogVehicles).toHaveBeenCalled())
  return { onChange }
}

describe('VehiclePicker', () => {
  it('shows a manual-entry fallback when no catalog is loaded yet', async () => {
    getCatalogVehicles.mockResolvedValue({ vehicles: [], count: 0, scannedAt: null })
    render(<VehiclePicker value="" onChange={vi.fn()} />)
    // waitFor(toHaveBeenCalled) only proves the API was CALLED, not that the
    // resulting setState/re-render has committed -- see ItemPicker.test.tsx
    // for the mechanism and the reproduction. findBy* polls until the
    // fallback actually appears instead of assuming one microtask tick was
    // enough.
    expect(await screen.findByPlaceholderText('e.g., Base.CarNormal')).toBeInTheDocument()
  })

  it('finds a vehicle by an accented, non-ASCII search term', async () => {
    await renderPicker()
    fireEvent.click(screen.getByRole('combobox', { name: 'Select vehicle' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter vehicles' }), { target: { value: 'générique' } })

    expect(await screen.findByText('Générique Berline')).toBeInTheDocument()
    expect(screen.queryByText('Ambulance')).not.toBeInTheDocument()
  })

  it('selecting a vehicle calls onChange with the real id and closes the dropdown', async () => {
    const { onChange } = await renderPicker()
    fireEvent.click(screen.getByRole('combobox', { name: 'Select vehicle' }))
    fireEvent.click(await screen.findByText('Générique Berline'))

    expect(onChange).toHaveBeenCalledWith('Base.CarNormal')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('renders the selected accented vehicle name on the trigger, not the raw id', async () => {
    await renderPicker({ value: 'Base.CarNormal' })
    expect(screen.getByText('Générique Berline')).toBeInTheDocument()
  })

  it('shows a real "no results" state for a search with no matches', async () => {
    await renderPicker()
    fireEvent.click(screen.getByRole('combobox', { name: 'Select vehicle' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter vehicles' }), { target: { value: 'zzzznonexistent' } })

    expect(await screen.findByText(/No vehicles match/)).toBeInTheDocument()
  })

  it('Clear resets the value', async () => {
    const { onChange } = await renderPicker({ value: 'Base.CarNormal' })
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  // 2026-08-29 backlog card
  // api-ts-declares-catalog-weight-mass-seats-non-optional-but-lua-guards-them:
  // PanelBridge.lua only sets mass/seats on a successful pcall --
  // getSeatNumber() is a known B42 Kahlua thrower -- so a real catalog
  // entry can genuinely omit both. Proves the now-optional fields render
  // without crashing and without a bogus badge.
  it('renders a vehicle with no mass/seats (the real Lua-omission shape) without crashing or showing mass/seat badges', async () => {
    const NO_MECHANICS: CatalogVehicle = { id: 'Base.NoMechanicsVan', name: 'No Mechanics Van' }
    getCatalogVehicles.mockResolvedValue({
      vehicles: [...VEHICLES, NO_MECHANICS],
      count: VEHICLES.length + 1,
      scannedAt: null,
    })
    render(<VehiclePicker value="Base.NoMechanicsVan" onChange={vi.fn()} />)

    // Same race as the manual-entry-fallback test above -- assert on the
    // settled render via findBy*, not a toHaveBeenCalled() check followed
    // by a synchronous getBy*.
    expect(await screen.findByText('No Mechanics Van')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('combobox', { name: 'Select vehicle' }))
    expect(await screen.findByText('Police Cruiser')).toBeInTheDocument()
    // The mechanics-bearing vehicles still show their mass badge; only the
    // missing-data one doesn't -- proves the guard is per-vehicle.
    expect(screen.getByText('1.2t')).toBeInTheDocument()
  })

  describe('getVehicleType classification -- misclassifying a vehicle sends the operator to the wrong category', () => {
    it('classifies an explicit police vehicle as Emergency & Military, not Sedans', () => {
      expect(getVehicleType({ id: 'Base.PoliceCruiser', name: 'Police Cruiser', mass: 1600, seats: 4 })).toBe('Emergency & Military')
    })
    it('classifies a zero-seat towed vehicle as Trailers', () => {
      expect(getVehicleType({ id: 'Base.Trailer01', name: 'Small Trailer', mass: 400, seats: 0 })).toBe('Trailers')
    })
    it('falls back to Sedans for an unrecognized ordinary car', () => {
      expect(getVehicleType({ id: 'Base.CarNormal', name: 'Générique Berline', mass: 1200, seats: 4 })).toBe('Sedans')
    })
    it('does not crash and falls back to Sedans when mass/seats are both genuinely absent (real Lua-omission shape)', () => {
      expect(getVehicleType({ id: 'Base.UnknownRig', name: 'Unknown Rig' })).toBe('Sedans')
    })
  })
})
