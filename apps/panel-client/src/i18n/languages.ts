// THE single place that declares which languages this panel supports.
//
// Adding a language: create apps/panel-client/src/locales/<code>/ with the same
// namespace files as English (see apps/panel-client/src/locales/README.md), then add
// one row to LANGUAGES below. i18next's resources, the LanguageSwitcher's
// menu, and the locale parity test all DERIVE from this file rather than
// naming languages of their own — nothing else should need to change.
export interface LanguageDef {
  code: string
  // Always the language's OWN name for itself (Deutsch, not German) —
  // shown in the switcher regardless of which language is currently
  // active. Deliberately not a translation key: a translated language name
  // would need adding to every OTHER locale's files, which is exactly the
  // one-more-file-per-language trap this registry exists to avoid.
  nativeName: string
  // Text direction. Omitted (rather than defaulted to 'ltr' here) so a
  // reader scanning this list sees directionality only where it's actually
  // non-default -- directionOf() below is what supplies the 'ltr' default
  // everywhere that isn't the registry itself.
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

// The authored language: new keys are written here first, and the locale
// parity test treats it as ground truth that every other registered
// language must match key-for-key.
export const SOURCE_LANGUAGE = 'en'

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code)

// A free function over a LanguageDef, not a method or a lookup-by-code, so
// it's trivially testable against a synthetic RTL fixture without needing
// an actual RTL row in LANGUAGES above (there isn't one yet).
export function directionOf(lang: LanguageDef | undefined): 'ltr' | 'rtl' {
  return lang?.dir === 'rtl' ? 'rtl' : 'ltr'
}

export function isRTL(code: string): boolean {
  return directionOf(LANGUAGES.find((l) => l.code === code)) === 'rtl'
}
