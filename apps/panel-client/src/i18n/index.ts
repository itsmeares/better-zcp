import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { LANGUAGE_CODES, SOURCE_LANGUAGE, isRTL } from './languages'

export { LANGUAGES, SOURCE_LANGUAGE, LANGUAGE_CODES, isRTL, directionOf } from './languages'
export type { LanguageDef } from './languages'
export type SupportedLanguage = string

export const LANGUAGE_STORAGE_KEY = 'zcp-language'

// Discovers every apps/panel-client/src/locales/<code>/<namespace>.json file at build
// time — no per-language, per-namespace import list to maintain. Adding a
// language folder (or a namespace file within one) is picked up here with
// no code change. See apps/panel-client/src/locales/README.md.
// i18next's own Resource type is this loose (ResourceKey = string | an
// object of unspecified shape), so `any` here matches its actual contract
// rather than fighting it with a narrower type that doesn't describe it.
const localeModules = import.meta.glob('../locales/*/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, any>

const LOCALE_PATH_RE = /\.\.\/locales\/([^/]+)\/([^/]+)\.json$/

const resources: Record<string, Record<string, any>> = {}
for (const [filePath, mod] of Object.entries(localeModules)) {
  const match = filePath.match(LOCALE_PATH_RE)
  if (!match) continue
  const [, code, namespace] = match
  resources[code] ??= {}
  resources[code][namespace] = mod
}

const namespaces = [...new Set(Object.values(resources).flatMap((r) => Object.keys(r)))]

function isSupportedLanguage(value: string | null | undefined): value is SupportedLanguage {
  return !!value && LANGUAGE_CODES.includes(value)
}

function mapBrowserLanguage(raw: string | null | undefined): SupportedLanguage | null {
  if (!raw) return null
  const tag = raw.trim().replace(/_/g, '-')
  const lower = tag.toLowerCase()
  if (isSupportedLanguage(tag)) return tag
  if (
    lower.startsWith('zh-hant') ||
    lower.startsWith('zh-tw') ||
    lower.startsWith('zh-hk') ||
    lower.startsWith('zh-mo')
  ) {
    return 'zh-TW'
  }
  if (
    lower.startsWith('zh-hans') ||
    lower.startsWith('zh-cn') ||
    lower.startsWith('zh-sg')
  ) {
    return 'zh-CN'
  }
  return null
}

// Bare primary subtag (fr-FR -> fr, zh-Hant-TW -> zh), lowercased.
function bareSubtag(raw: string): string {
  return raw.trim().replace(/_/g, '-').split('-')[0].toLowerCase()
}

export function detectInitialLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (isSupportedLanguage(stored)) return stored
  } catch {
    // localStorage unavailable (privacy mode, disabled storage) — fall through
  }
  const candidates = [
    navigator.language,
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
  ]
  for (const raw of candidates) {
    const mapped = mapBrowserLanguage(raw)
    if (mapped) return mapped
  }
  // Second pass, bare-subtag fallback: mapBrowserLanguage() above only
  // exact-matches a full tag or special-cases zh-*, so a browser reporting
  // a region-qualified tag with no exact/zh match (fr-FR, de-DE, es-ES,
  // ht-HT, or a real ar-PS/ar-EG/ar-SA once Arabic is registered -- see
  // rtl-and-new-languages) fell straight through to English. This restores
  // the pre-4666849b prefix-match behaviour, but as a FALLBACK layer run
  // only after every candidate has already had its shot at an exact/zh
  // match, so the newer, more specific behaviour still wins whenever it
  // applies -- fixes the fr-FR/de-DE/es-ES/ht-HT regression without
  // reverting the Chinese fix that was the actual point of that rewrite.
  for (const raw of candidates) {
    const bare = bareSubtag(raw)
    if (isSupportedLanguage(bare)) return bare
  }
  return SOURCE_LANGUAGE
}

// Keeps <html dir>/<html lang> in sync with the active language -- on
// first load AND on every runtime switch (the switcher is a live control,
// not a boot-time setting). Applied synchronously before i18next's own
// init resolves so the very first paint is already correct rather than
// flashing ltr and then flipping; the 'languageChanged' subscription below
// covers every change after that, including setLanguage()'s own
// i18n.changeLanguage() call. For all seven languages registered today
// this is a no-op every time (isRTL() is false for all of them) -- there is no
// RTL row in LANGUAGES yet.
function applyDocumentDirection(lang: string): void {
  document.documentElement.dir = isRTL(lang) ? 'rtl' : 'ltr'
  document.documentElement.lang = lang
}

const initialLanguage = detectInitialLanguage()
applyDocumentDirection(initialLanguage)

i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: SOURCE_LANGUAGE,
  ns: namespaces,
  defaultNS: 'shell',
  interpolation: { escapeValue: false }, // React already escapes interpolated values
  returnEmptyString: false,
})

i18n.on('languageChanged', applyDocumentDirection)

export function setLanguage(lang: SupportedLanguage): void {
  void i18n.changeLanguage(lang)
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang)
  } catch {
    // ignore — language just won't persist across reloads
  }
}

export function getCurrentLanguage(): SupportedLanguage {
  return isSupportedLanguage(i18n.language) ? i18n.language : SOURCE_LANGUAGE
}

export default i18n
