import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import {
  humanizeTemplateKey,
  getIniKeyLabel,
  getSandboxKeyLabel,
  formatDifficultyLabel,
  formatDiffValue,
} from '../templateLabels'

describe('humanizeTemplateKey', () => {
  it('splits camelCase and PascalCase words', () => {
    expect(humanizeTemplateKey('ZombieRespawn')).toBe('Zombie Respawn')
    expect(humanizeTemplateKey('MaximumLooted')).toBe('Maximum Looted')
    expect(humanizeTemplateKey('HoursForLootRespawn')).toBe('Hours For Loot Respawn')
  })

  it('keeps acronyms grouped and splits the following word', () => {
    expect(humanizeTemplateKey('PVPMeleeDamageModifier')).toBe('PVP Melee Damage Modifier')
  })
})

describe('getIniKeyLabel / getSandboxKeyLabel', () => {
  it('prefers the curated schema label when one exists', () => {
    expect(getIniKeyLabel('PVP')).not.toBe('')
  })

  it('falls back to a humanized key for unknown settings', () => {
    expect(getSandboxKeyLabel('SomeBrandNewSetting')).toBe('Some Brand New Setting')
  })

  // bug-hunt-2026-08-31: PZ's own SandboxVars.lua genuinely reuses the same
  // key across two unrelated tables -- 'Farming' is both settings.Farming
  // (a 1-5 Agriculture-skill-growth select) and MultiplierConfig.Farming (a
  // 0.001-1000 XP multiplier). Without `section`, getSandboxKeyLabel('Farming')
  // always resolved to whichever entry happened to come first in
  // SANDBOX_SCHEMA -- TemplateDiffList.tsx (the "review before applying"
  // template preview) would show the WRONG label on one of the two rows for
  // any template touching both. This is the regression test: passing the
  // diff row's own `section` must resolve each to its real, distinct
  // setting rather than colliding on the bare key.
  it('disambiguates a key PZ reuses across two unrelated sandbox tables using `section`', () => {
    expect(getSandboxKeyLabel('Farming', 'settings')).toBe('Agriculture Multiplier')
    expect(getSandboxKeyLabel('Farming', 'MultiplierConfig')).toBe('Farming XP')
    expect(getSandboxKeyLabel('Farming', 'settings')).not.toBe(getSandboxKeyLabel('Farming', 'MultiplierConfig'))
  })

  it('without a section, falls back to the first schema match (documents the pre-fix ambiguity, not a new guarantee)', () => {
    expect(getSandboxKeyLabel('Farming')).toBe('Agriculture Multiplier')
  })
})

describe('formatDifficultyLabel', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('title-cases a plain word', () => {
    expect(formatDifficultyLabel('hardcore')).toBe('Hardcore')
  })

  it('upper-cases known acronyms', () => {
    expect(formatDifficultyLabel('pvp')).toBe('PVP')
  })

  it('splits hyphenated levels into title-cased words', () => {
    expect(formatDifficultyLabel('first-week')).toBe('First Week')
  })

  it('returns the translated "Custom" label for an empty level, in English', () => {
    expect(formatDifficultyLabel(undefined)).toBe('Custom')
  })

  // This is the test that would have caught the original defect: the old
  // implementation returned the English literal "Custom" unconditionally,
  // in every language. It reuses templateCard.json's own "custom" key
  // (already shipped for the built-in/custom template-type badge) rather
  // than a new key, so this exercises the real committed locale files, not
  // a synthetic bundle.
  it('translates "Custom" for an empty level when a different language is active', async () => {
    await i18n.changeLanguage('de')
    expect(formatDifficultyLabel(undefined)).toBe('Individuell')

    await i18n.changeLanguage('fr')
    expect(formatDifficultyLabel(undefined)).toBe('Personnalisé')
  })
})

describe('formatDiffValue', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders booleans as On/Off, in English', () => {
    expect(formatDiffValue(true)).toBe('On')
    expect(formatDiffValue(false)).toBe('Off')
  })

  it('renders string booleans as On/Off, in English', () => {
    expect(formatDiffValue('true')).toBe('On')
    expect(formatDiffValue('false')).toBe('Off')
  })

  it('renders undefined/null/empty as (not set), in English', () => {
    expect(formatDiffValue(undefined)).toBe('(not set)')
    expect(formatDiffValue(null)).toBe('(not set)')
    expect(formatDiffValue('')).toBe('(not set)')
  })

  it('renders numbers and other strings as-is', () => {
    expect(formatDiffValue(5)).toBe('5')
    expect(formatDiffValue('Muldraugh, KY')).toBe('Muldraugh, KY')
  })

  // This is the test that would have caught the original defect: On/Off/
  // (not set) were English string literals with zero i18n involvement, so
  // this suite passing was never proof the feature worked in another
  // language -- it just proved the hardcoded fallback matched the
  // hardcoded assertion. These check the real committed de/zh-CN
  // templateDiffList.json keys, not a synthetic bundle.
  it('translates On/Off/(not set) when a different language is active', async () => {
    await i18n.changeLanguage('de')
    expect(formatDiffValue(true)).toBe('Ein')
    expect(formatDiffValue(false)).toBe('Aus')
    expect(formatDiffValue(undefined)).toBe('(nicht festgelegt)')

    await i18n.changeLanguage('zh-CN')
    expect(formatDiffValue(true)).toBe('开')
    expect(formatDiffValue(false)).toBe('关')
    expect(formatDiffValue(undefined)).toBe('（未设置）')
  })
})
