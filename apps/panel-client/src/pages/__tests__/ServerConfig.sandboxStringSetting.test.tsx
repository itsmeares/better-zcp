import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SandboxSettingRow } from '../ServerConfig'
import { SANDBOX_SCHEMA } from '@/lib/serverConfigSchema'

// GH#143 ("Buffered"): SandboxSettingRow's renderer had no `type === 'string'`
// branch -- boolean and select were explicitly gated, and EVERYTHING else,
// including type: 'string', fell into the numeric branch: inputMode="decimal"
// and, critically, onChange wrapped every keystroke (and paste) in
// normalizeNumericInput(), which turns every comma into a period. Exactly
// two sandbox settings are type: 'string' -- both comma-separated item
// lists -- so a user could not type or paste a comma into either one, and
// WorldItemRemovalList's own shipped default couldn't be retyped verbatim.
//
// Pulling both settings from the REAL schema rather than hand-authoring a
// fixture, per god's instruction to confirm the count (2 of 269 sandbox
// entries) rather than re-derive it from a description.

const WORLD_ITEM_REMOVAL_LIST = SANDBOX_SCHEMA.find((s) => s.key === 'WorldItemRemovalList')!
const LOOT_ITEM_REMOVAL_LIST = SANDBOX_SCHEMA.find((s) => s.key === 'LootItemRemovalList')!

describe('ServerConfig -- sandbox string settings are not coerced through the numeric input', () => {
  it('the schema has exactly these two type: string entries (denominator check)', () => {
    const stringSettings = SANDBOX_SCHEMA.filter((s) => s.type === 'string')
    expect(stringSettings.map((s) => s.key).sort()).toEqual(['LootItemRemovalList', 'WorldItemRemovalList'])
  })

  it('WorldItemRemovalList renders as a plain text input, not a decimal one', () => {
    render(<SandboxSettingRow setting={WORLD_ITEM_REMOVAL_LIST} value="Base.Hat, Base.Glasses" onChange={vi.fn()} />)
    const input = screen.getByDisplayValue('Base.Hat, Base.Glasses')
    expect(input).not.toHaveAttribute('inputMode', 'decimal')
    expect(input.className).not.toMatch(/text-end/)
  })

  it('typing a comma into WorldItemRemovalList survives verbatim', () => {
    const onChange = vi.fn()
    render(<SandboxSettingRow setting={WORLD_ITEM_REMOVAL_LIST} value="" onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Base.Hat, Base.Glasses' } })
    expect(onChange).toHaveBeenCalledWith(WORLD_ITEM_REMOVAL_LIST, 'Base.Hat, Base.Glasses')
  })

  it('the real shipped WorldItemRemovalList default round-trips verbatim (typed or pasted)', () => {
    const defaultValue = WORLD_ITEM_REMOVAL_LIST.default as string
    expect(defaultValue).toContain(',')
    const onChange = vi.fn()
    render(<SandboxSettingRow setting={WORLD_ITEM_REMOVAL_LIST} value="" onChange={onChange} />)
    const input = screen.getByRole('textbox')
    // A paste fires the same change event with the full value in one shot,
    // exactly like this -- the whole default string arriving at once,
    // rather than one keystroke at a time.
    fireEvent.paste(input)
    fireEvent.change(input, { target: { value: defaultValue } })
    expect(onChange).toHaveBeenCalledWith(WORLD_ITEM_REMOVAL_LIST, defaultValue)
  })

  it('typing a comma into LootItemRemovalList (the unreported twin) also survives verbatim', () => {
    const onChange = vi.fn()
    render(<SandboxSettingRow setting={LOOT_ITEM_REMOVAL_LIST} value="" onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Base.Bag, Base.Bag2' } })
    expect(onChange).toHaveBeenCalledWith(LOOT_ITEM_REMOVAL_LIST, 'Base.Bag, Base.Bag2')
  })

  it('a genuinely numeric sandbox setting is unaffected -- still coerces commas to periods', () => {
    const numberSetting = SANDBOX_SCHEMA.find((s) => s.type === 'number')!
    const onChange = vi.fn()
    render(<SandboxSettingRow setting={numberSetting} value="" onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '0,8' } })
    expect(onChange).toHaveBeenCalledWith(numberSetting, '0.8')
  })
})
