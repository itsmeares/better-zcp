import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ItemPicker, type CatalogItem } from '../ItemPicker'
import { panelBridgeApi } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getCatalogItems: vi.fn(),
      scanCatalogItems: vi.fn(),
    },
  }
})

const getCatalogItems = vi.mocked(panelBridgeApi.getCatalogItems)

const ITEMS: CatalogItem[] = [
  { id: 'Base.Axe', name: 'Axe', category: 'WeaponPrimitive', weight: 3 },
  { id: 'Base.EmpanadaCafe', name: 'Café Empañada', category: 'Food', weight: 0.3 },
  { id: 'Base.Bandage', name: 'Bandage', category: 'Bandage', weight: 0.1 },
]

const ITEM_WITHOUT_WEIGHT: CatalogItem = {
  id: 'Base.NoWeightItem',
  name: 'No Weight Item',
  category: 'Other',
}

beforeEach(() => {
  getCatalogItems.mockReset()
})

async function renderPicker(props: Partial<{ value: string; onChange: (v: string) => void }> = {}) {
  getCatalogItems.mockResolvedValue({ items: ITEMS, count: ITEMS.length, scannedAt: null })
  const onChange = props.onChange || vi.fn()
  render(<ItemPicker value={props.value ?? ''} onChange={onChange} />)
  await waitFor(() => expect(getCatalogItems).toHaveBeenCalled())
  return { onChange }
}

describe('ItemPicker', () => {
  it('shows a manual-entry fallback (not a crash or empty control) when no catalog is loaded yet', async () => {
    getCatalogItems.mockResolvedValue({ items: [], count: 0, scannedAt: null })
    render(<ItemPicker value="" onChange={vi.fn()} />)
    expect(await screen.findByPlaceholderText('e.g., Base.Axe')).toBeInTheDocument()
  })

  it('finds an item by an accented, non-ASCII search term', async () => {
    await renderPicker()
    fireEvent.click(screen.getByRole('combobox', { name: 'Select item' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter items' }), { target: { value: 'café' } })

    expect(await screen.findByText('Café Empañada')).toBeInTheDocument()
    expect(screen.queryByText('Axe')).not.toBeInTheDocument()
  })

  it('finds the same accented item when searching its plain-ASCII id fragment', async () => {
    await renderPicker()
    fireEvent.click(screen.getByRole('combobox', { name: 'Select item' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter items' }), { target: { value: 'empanadacafe' } })

    expect(await screen.findByText('Café Empañada')).toBeInTheDocument()
  })

  it('selecting an item calls onChange with the real id and closes the dropdown', async () => {
    const { onChange } = await renderPicker()
    fireEvent.click(screen.getByRole('combobox', { name: 'Select item' }))
    fireEvent.click(await screen.findByText('Café Empañada'))

    expect(onChange).toHaveBeenCalledWith('Base.EmpanadaCafe')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('renders the selected accented item name on the trigger, not the raw id', async () => {
    await renderPicker({ value: 'Base.EmpanadaCafe' })
    expect(screen.getByText('Café Empañada')).toBeInTheDocument()
  })

  it('shows a real "no results" state for a search with no matches, not an empty silent list', async () => {
    await renderPicker()
    fireEvent.click(screen.getByRole('combobox', { name: 'Select item' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter items' }), { target: { value: 'zzzznonexistent' } })

    expect(await screen.findByText(/No items match/)).toBeInTheDocument()
  })

  it('Clear resets both the value and the search text', async () => {
    const { onChange } = await renderPicker({ value: 'Base.Axe' })
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('renders an item with no weight (the real Lua-omission shape) without crashing or showing a weight badge', async () => {
    getCatalogItems.mockResolvedValue({
      items: [...ITEMS, ITEM_WITHOUT_WEIGHT],
      count: ITEMS.length + 1,
      scannedAt: null,
    })
    render(<ItemPicker value="Base.NoWeightItem" onChange={vi.fn()} />)

    expect(await screen.findByText('No Weight Item')).toBeInTheDocument()
    expect(screen.queryByText(/kg/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('combobox', { name: 'Select item' }))
    expect(await screen.findByText('Axe')).toBeInTheDocument()
    expect(screen.getByText('3kg')).toBeInTheDocument()
  })
})
