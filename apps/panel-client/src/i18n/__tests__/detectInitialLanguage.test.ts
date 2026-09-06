import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectInitialLanguage, LANGUAGE_STORAGE_KEY } from '@/i18n'


function mockNavigatorLanguages(language: string, languages: string[] = [language]) {
  Object.defineProperty(navigator, 'language', { value: language, configurable: true })
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true })
}

describe('detectInitialLanguage -- bare-subtag fallback', () => {
  const originalLanguage = navigator.language
  const originalLanguages = navigator.languages

  beforeEach(() => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY)
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'language', { value: originalLanguage, configurable: true })
    Object.defineProperty(navigator, 'languages', { value: originalLanguages, configurable: true })
    localStorage.removeItem(LANGUAGE_STORAGE_KEY)
  })

  it('resolves fr-FR alone (no bare fr anywhere in navigator.languages) to fr -- the reported regression', () => {
    mockNavigatorLanguages('fr-FR')
    expect(detectInitialLanguage()).toBe('fr')
  })

  it('resolves de-DE alone to de', () => {
    mockNavigatorLanguages('de-DE')
    expect(detectInitialLanguage()).toBe('de')
  })

  it('resolves es-ES alone to es', () => {
    mockNavigatorLanguages('es-ES')
    expect(detectInitialLanguage()).toBe('es')
  })

  it('still exact-matches zh-Hant-TW to zh-TW (the actual Chinese fix, unregressed)', () => {
    mockNavigatorLanguages('zh-Hant-TW')
    expect(detectInitialLanguage()).toBe('zh-TW')
  })

  it('still exact-matches an already-bare supported code (zh-CN) directly', () => {
    mockNavigatorLanguages('zh-CN')
    expect(detectInitialLanguage()).toBe('zh-CN')
  })

  it('prefers an exact/zh match over a later bare-subtag match across candidates', () => {
    mockNavigatorLanguages('zh-Hant-TW', ['zh-Hant-TW', 'en'])
    expect(detectInitialLanguage()).toBe('zh-TW')
  })

  it('falls back to English when nothing -- exact, zh, or bare -- matches any candidate', () => {
    mockNavigatorLanguages('ja-JP', ['ja-JP', 'ko-KR'])
    expect(detectInitialLanguage()).toBe('en')
  })

  it('a stored language in localStorage still wins over navigator entirely', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'de')
    mockNavigatorLanguages('fr-FR')
    expect(detectInitialLanguage()).toBe('de')
  })
})
