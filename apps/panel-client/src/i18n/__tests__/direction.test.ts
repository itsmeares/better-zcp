import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n, { LANGUAGES, isRTL, directionOf } from '@/i18n'
import type { LanguageDef } from '@/i18n'

describe('directionOf', () => {
  it('defaults to ltr when dir is absent', () => {
    const lang: LanguageDef = { code: 'xx', nativeName: 'Xx' }
    expect(directionOf(lang)).toBe('ltr')
  })

  it('defaults to ltr for an undefined language (unknown code)', () => {
    expect(directionOf(undefined)).toBe('ltr')
  })

  it('honours an explicit ltr', () => {
    const lang: LanguageDef = { code: 'xx', nativeName: 'Xx', dir: 'ltr' }
    expect(directionOf(lang)).toBe('ltr')
  })

  it('honours an explicit rtl', () => {
    const lang: LanguageDef = { code: 'xx', nativeName: 'Xx', dir: 'rtl' }
    expect(directionOf(lang)).toBe('rtl')
  })
})

describe('isRTL -- every language actually registered today', () => {
  it.each(LANGUAGES.map((l) => [l.code, l.dir === 'rtl'] as const))(
    'isRTL(%s) is %s',
    (code, expected) => {
      expect(isRTL(code)).toBe(expected)
    },
  )

  it('at least one registered language is RTL, and at least one is not', () => {
    expect(LANGUAGES.some((l) => l.dir === 'rtl')).toBe(true)
    expect(LANGUAGES.some((l) => l.dir !== 'rtl')).toBe(true)
  })

  it('is false for an unregistered code', () => {
    expect(isRTL('xx-not-a-real-language')).toBe(false)
  })
})

describe('document <html dir>/<html lang> sync on language switch', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('sets dir from the registry and updates lang for every registered language', async () => {
    for (const lang of LANGUAGES) {
      await i18n.changeLanguage(lang.code)
      expect(document.documentElement.dir).toBe(directionOf(lang))
      expect(document.documentElement.lang).toBe(lang.code)
    }
  })

  it('flips dir back to ltr when switching away from an RTL language', async () => {
    const rtl = LANGUAGES.find((l) => l.dir === 'rtl')
    if (!rtl) throw new Error('no RTL language registered -- this test is vacuous')
    await i18n.changeLanguage(rtl.code)
    expect(document.documentElement.dir).toBe('rtl')
    await i18n.changeLanguage('en')
    expect(document.documentElement.dir).toBe('ltr')
  })
})
