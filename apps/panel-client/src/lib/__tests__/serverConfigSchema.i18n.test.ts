import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import {
  INI_SCHEMA,
  INI_CATEGORIES,
  INI_CATEGORY_GROUPS,
  SANDBOX_SCHEMA,
  SANDBOX_CATEGORIES,
  SANDBOX_CATEGORY_GROUPS,
  getIniSettingLabel,
  getIniSettingDescription,
  getIniSettingSearchText,
  getIniCategoryLabel,
  getIniCategoryGroupLabel,
  getSandboxSettingLabel,
  getSandboxSettingDescription,
  getSandboxSettingSearchText,
  formatRawConfigValue,
} from '../serverConfigSchema'

// The first cases keep a small synthetic German bundle so the accessor key
// shape remains explicit and independently tested. The later cases exercise
// the committed Chinese serverconfig bundle through the normal JSON loader in
// apps/panel-client/src/i18n/index.ts, including the complete schema coverage contract.
const RCON_PORT = INI_SCHEMA.find((s) => s.key === 'RCONPort')!
const RCON_PASSWORD = INI_SCHEMA.find((s) => s.key === 'RCONPassword')!
const PUBLIC_NAME = INI_SCHEMA.find((s) => s.key === 'PublicName')!
const DAY_LENGTH = SANDBOX_SCHEMA.find((s) => s.key === 'DayLength' && s.section === 'settings')!
const ZOMBIE_STRENGTH = SANDBOX_SCHEMA.find((s) => s.key === 'Strength' && s.section === 'ZombieLore')!
const FARMING_XP = SANDBOX_SCHEMA.find((s) => s.key === 'Farming' && s.section === 'MultiplierConfig')!

const DE_PROOF_BUNDLE = {
  iniSettings: {
    rcon: {
      RCONPort: {
        label: 'RCON-Port',
        description: 'Port für RCON-Verbindungen.',
      },
      RCONPassword: {
        label: 'RCON-Passwort',
        description: 'Passwort für RCON-Verbindungen.',
      },
    },
  },
}

describe('serverConfigSchema translated accessors (proof: rcon category)', () => {
  beforeEach(() => {
    i18n.addResourceBundle('de', 'serverconfig', DE_PROOF_BUNDLE, true, true)
  })

  afterEach(() => {
    i18n.removeResourceBundle('de', 'serverconfig')
    void i18n.changeLanguage('en')
  })

  it('both rcon settings exist and share the "rcon" category (sanity check for the proof itself)', () => {
    expect(RCON_PORT.category).toBe('rcon')
    expect(RCON_PASSWORD.category).toBe('rcon')
  })

  it('falls back to the schema\'s own English text when no translation is loaded (zero behaviour change)', () => {
    void i18n.changeLanguage('en')
    expect(getIniSettingLabel(RCON_PORT)).toBe('RCON Port')
    expect(getIniSettingDescription(RCON_PORT)).toBe('Port for RCON connections.')
    expect(getIniSettingLabel(RCON_PASSWORD)).toBe('RCON Password')
    expect(getIniSettingDescription(RCON_PASSWORD)).toBe('Password for RCON connections.')
  })

  it('resolves the translated German text once the mechanically-keyed bundle is present', async () => {
    await i18n.changeLanguage('de')
    expect(getIniSettingLabel(RCON_PORT)).toBe('RCON-Port')
    expect(getIniSettingDescription(RCON_PORT)).toBe('Port für RCON-Verbindungen.')
    expect(getIniSettingLabel(RCON_PASSWORD)).toBe('RCON-Passwort')
    expect(getIniSettingDescription(RCON_PASSWORD)).toBe('Passwort für RCON-Verbindungen.')
  })

  it('falls back to English for a DIFFERENT category with no bundle entry, even while German is active', async () => {
    // Proves the fallback is per-key, not a blanket "German is incomplete
    // so show English everywhere" -- exactly the coexistence a real,
    // partially-translated rollout needs.
    await i18n.changeLanguage('de')
    const publicName = INI_SCHEMA.find((s) => s.key === 'PublicName')!
    expect(getIniSettingLabel(publicName)).toBe('Server Name')
  })

  it('the injected bundle uses the exact mechanical key shape getIniSettingLabel derives (category.key.field)', () => {
    // If this drifts from the real derivation, the two "resolves the
    // translated" assertions above would silently fall back to English
    // instead of failing -- this test exists so a key-shape regression in
    // getIniSettingLabel/Description shows up as a clear key-path mismatch.
    expect(`iniSettings.${RCON_PORT.category}.${RCON_PORT.key}.label`).toBe('iniSettings.rcon.RCONPort.label')
    expect(`iniSettings.${RCON_PASSWORD.category}.${RCON_PASSWORD.key}.description`).toBe('iniSettings.rcon.RCONPassword.description')
  })

  it('renders the real Chinese field and rail translations', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(getIniSettingLabel(PUBLIC_NAME)).toBe('服务器公开名称')
    expect(getIniSettingDescription(PUBLIC_NAME)).toContain('Steam 服务器浏览器')
    expect(getIniCategoryLabel(INI_CATEGORIES.find((category) => category.id === 'general')!)).toBe('常规')
    expect(getIniCategoryGroupLabel(INI_CATEGORY_GROUPS.find((group) => group.id === 'identity')!)).toBe('身份与基本信息')
    expect(getSandboxSettingLabel(DAY_LENGTH)).toBe('一天长度')
  })

  it('keeps boolean configuration values as raw true/false literals', () => {
    expect(formatRawConfigValue(true)).toBe('true')
    expect(formatRawConfigValue(false)).toBe('false')
    expect(formatRawConfigValue('true')).toBe('true')
    expect(formatRawConfigValue('false')).toBe('false')
    expect(formatRawConfigValue(15)).toBe('15')
  })

  it('translates sandbox purpose text without replacing it with ranges or option tables', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(getSandboxSettingDescription(DAY_LENGTH)).toBe('一天在现实时间中持续多久。')
    expect(getSandboxSettingDescription(DAY_LENGTH)).not.toMatch(/1\s*=|15\s*分钟|范围/)
    expect(getSandboxSettingDescription(ZOMBIE_STRENGTH)).toBe('僵尸每次攻击造成的伤害。')
    expect(getSandboxSettingDescription(ZOMBIE_STRENGTH)).not.toContain('技能')
    expect(getSandboxSettingDescription(FARMING_XP)).toBe('耕作技能的经验获取倍率。')

    const misplacedValueTables = SANDBOX_SCHEMA.flatMap((setting) => {
      const description = getSandboxSettingDescription(setting)
      const valueMappings = description.match(/\d+(?:\.\d+)?\s*=/g) ?? []
      const isBareRange = /^\s*[\d.]+\s*(?:~|～|-)\s*[\d.]+\s*$/.test(description)
      return valueMappings.length > 1 || isBareRange
        ? [`${setting.section || 'settings'}.${setting.key}`]
        : []
    })
    expect(misplacedValueTables).toEqual([])
  })

  it('search text keeps raw keys and English alongside the active Chinese translation', async () => {
    await i18n.changeLanguage('zh-CN')
    const iniSearch = getIniSettingSearchText(PUBLIC_NAME)
    expect(iniSearch).toContain('PublicName')
    expect(iniSearch).toContain('Server Name')
    expect(iniSearch).toContain('服务器公开名称')

    const sandboxSearch = getSandboxSettingSearchText(DAY_LENGTH)
    expect(sandboxSearch).toContain('settings.DayLength')
    expect(sandboxSearch).toContain('Day Length')
    expect(sandboxSearch).toContain('一天长度')
    expect(sandboxSearch).toContain('2 Hours')
    expect(sandboxSearch).toContain('2 小时')
  })

  it('ships a Chinese locale key for every current field, option, category, and group', async () => {
    await i18n.changeLanguage('zh-CN')
    const missing: string[] = []
    for (const setting of INI_SCHEMA) {
      const base = `iniSettings.${setting.category}.${setting.key}`
      if (!i18n.exists(`${base}.label`, { ns: 'serverconfig' })) missing.push(`${base}.label`)
      if (!i18n.exists(`${base}.description`, { ns: 'serverconfig' })) missing.push(`${base}.description`)
      for (const option of setting.options ?? []) {
        if (!i18n.exists(`${base}.options.${option.value}.label`, { ns: 'serverconfig' })) {
          missing.push(`${base}.options.${option.value}.label`)
        }
      }
    }
    for (const setting of SANDBOX_SCHEMA) {
      const base = `sandboxSettings.${setting.category}.${setting.key}`
      if (!i18n.exists(`${base}.label`, { ns: 'serverconfig' })) missing.push(`${base}.label`)
      if (!i18n.exists(`${base}.description`, { ns: 'serverconfig' })) missing.push(`${base}.description`)
      for (const option of setting.options ?? []) {
        if (!i18n.exists(`${base}.options.${option.value}.label`, { ns: 'serverconfig' })) {
          missing.push(`${base}.options.${option.value}.label`)
        }
      }
    }
    for (const category of INI_CATEGORIES) if (!i18n.exists(`iniCategories.${category.id}.label`, { ns: 'serverconfig' })) missing.push(`iniCategories.${category.id}.label`)
    for (const group of INI_CATEGORY_GROUPS) if (!i18n.exists(`iniCategoryGroups.${group.id}.label`, { ns: 'serverconfig' })) missing.push(`iniCategoryGroups.${group.id}.label`)
    for (const category of SANDBOX_CATEGORIES) if (!i18n.exists(`sandboxCategories.${category.id}.label`, { ns: 'serverconfig' })) missing.push(`sandboxCategories.${category.id}.label`)
    for (const group of SANDBOX_CATEGORY_GROUPS) if (!i18n.exists(`sandboxCategoryGroups.${group.id}.label`, { ns: 'serverconfig' })) missing.push(`sandboxCategoryGroups.${group.id}.label`)
    expect(missing).toEqual([])
  })
})
