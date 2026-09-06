import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import {
  SANDBOX_SCHEMA,
  getSandboxSettingLabel,
  getSandboxSettingDescription,
  getSandboxSettingOptionLabel,
} from '../serverConfigSchema'

// Proof-of-mechanism for the sandboxPz namespace: Project Zomboid's own
// official sandbox translations, extracted verbatim from the game's
// Sandbox.json language files, wired in as a fallback tier for SETTING AND
// OPTION LABELS ONLY. Descriptions are deliberately excluded (they're
// panel-authored, not a PZ tooltip transcription) -- these tests pin that
// boundary as real behaviour, not just a comment.
//
// Unlike the INI proof-of-mechanism test (which injects a synthetic bundle
// because no real iniSettings.* locale keys exist yet), this exercises the
// REAL apps/panel-client/src/locales/<lang>/sandboxPz.json files committed alongside
// this test -- so a future edit to either the schema or the extraction that
// breaks the key shape or the data fails here, not silently in the UI.

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
    // Descriptions are out of scope by design: PZ's tooltips were written
    // for its own options screen, ours for this panel. This must stay
    // exactly the schema's English string in every locale until a human
    // decides otherwise -- see the sandboxPz extraction report.
    await i18n.changeLanguage('fr')
    expect(getSandboxSettingDescription(META_EVENT)).toBe('Distant gunshots, screams, etc.')
    await i18n.changeLanguage('de')
    expect(getSandboxSettingDescription(META_EVENT)).toBe('Distant gunshots, screams, etc.')
  })

  it('falls back to English per-key when the active language\'s PZ translation is itself incomplete', async () => {
    // DayNightCycle has no German entry in PZ's own DE/Sandbox.json (a real,
    // partial-coverage gap, not a synthetic one). de/sandboxPz.json still
    // carries a key for it (localeParity requires every locale to match
    // en's key set), but its VALUE is the schema's own English text, written
    // in explicitly at extraction time rather than left absent -- same
    // rendered result as an absent-key fallback would give, proven here as
    // the actual behaviour rather than assumed from the extractor's design.
    // Proves the fallback is per-key, not a blanket "German is incomplete so
    // show English everywhere", the same property the INI proof-of-mechanism
    // test pins.
    await i18n.changeLanguage('de')
    expect(getSandboxSettingLabel(DAY_NIGHT_CYCLE)).toBe('Day/Night Cycle')
    expect(getSandboxSettingOptionLabel(DAY_NIGHT_CYCLE, 1)).toBe('Normal')
    // MetaEvent DOES have full German coverage -- confirms the fallback
    // above is genuinely per-setting, not every German lookup missing.
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
