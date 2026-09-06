export interface LanguageDef {
  code: string
  nativeName: string
  dir?: 'ltr' | 'rtl'
}

export const LANGUAGES: LanguageDef[] = [
  { code: 'en', nativeName: 'English' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'zh-CN', nativeName: '简体中文' },
  { code: 'zh-TW', nativeName: '繁體中文' },
  { code: 'es', nativeName: 'Español' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'ht', nativeName: 'Kreyòl ayisyen' },
  { code: 'uk', nativeName: 'Українська' },
  { code: 'ar', nativeName: 'العربية', dir: 'rtl' },
]

export const SOURCE_LANGUAGE = 'en'

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code)

export function directionOf(lang: LanguageDef | undefined): 'ltr' | 'rtl' {
  return lang?.dir === 'rtl' ? 'rtl' : 'ltr'
}

export function isRTL(code: string): boolean {
  return directionOf(LANGUAGES.find((l) => l.code === code)) === 'rtl'
}
