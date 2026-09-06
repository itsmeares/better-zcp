import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import {
  SANDBOX_SCHEMA,
  getSandboxSettingLabel,
  getSandboxSettingDescription,
  getSandboxSettingOptionLabel,
} from '../serverConfigSchema'


const META_EVENT = SANDBOX_SCHEMA.find((s) => s.key === 'MetaEvent')!
const DAY_NIGHT_CYCLE = SANDBOX_SCHEMA.find((s) => s.key === 'DayNightCycle')!

describe('sandboxPz translated accessors (PZ-sourced label/option-label fallback)', () => {
  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('renders the schema\'s own English text while English is active (en/sandboxPz.json is a full skeleton, but its values are mechanically the schema\'s own strings)', () => {
    expect(getSandboxSettingLabel(META_EVENT)).toBe('Meta Events')
    expect(getSandboxSettingOptionLabel(META_EVENT, 1)).toBe('Never')
    expect(getSandboxSettingOptionLabel(META_EVENT, 2)).toBe('Sometimes')
    expect(getSandboxSettingOptionLabel(META_EVENT, 3)).toBe('Often')
  })

  it('resolves PZ\'s own official French label and option labels once French is active', async () => {
    await i18n.changeLanguage('fr')
    expect(getSandboxSettingLabel(META_EVENT)).toBe('Évènements sonores')
    expect(getSandboxSettingOptionLabel(META_EVENT, 1)).toBe('Jamais')
    expect(getSandboxSettingOptionLabel(META_EVENT, 2)).toBe('De temps en temps')
    expect(getSandboxSettingOptionLabel(META_EVENT, 3)).toBe('Souvent')
  })

  it('never translates the description, even while a PZ-covered language is active', async () => {
    await i18n.changeLanguage('fr')
    expect(getSandboxSettingDescription(META_EVENT)).toBe('Distant gunshots, screams, etc.')
    await i18n.changeLanguage('de')
    expect(getSandboxSettingDescription(META_EVENT)).toBe('Distant gunshots, screams, etc.')
  })

  it('falls back to English per-key when the active language\'s PZ translation is itself incomplete', async () => {
    await i18n.changeLanguage('de')
    expect(getSandboxSettingLabel(DAY_NIGHT_CYCLE)).toBe('Day/Night Cycle')
    expect(getSandboxSettingOptionLabel(DAY_NIGHT_CYCLE, 1)).toBe('Normal')
    expect(getSandboxSettingLabel(META_EVENT)).not.toBe('Meta Events')
  })

  it('a hand-authored serverconfig.json override still wins over the PZ-extracted namespace', async () => {
    i18n.addResourceBundle(
      'fr',
      'serverconfig',
      { sandboxSettings: { survival: { MetaEvent: { label: 'Override Label FR' } } } },
      true,
      true,
    )
    await i18n.changeLanguage('fr')
    expect(getSandboxSettingLabel(META_EVENT)).toBe('Override Label FR')
    i18n.removeResourceBundle('fr', 'serverconfig')
  })
})
