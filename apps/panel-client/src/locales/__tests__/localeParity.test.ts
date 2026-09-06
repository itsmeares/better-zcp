import { describe, expect, it } from 'vitest'
import { LANGUAGES, SOURCE_LANGUAGE } from '../../i18n/languages'

const localeModules = import.meta.glob('../*/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, unknown>>

const LOCALE_PATH_RE = /\.\.\/([^/]+)\/([^/]+)\.json$/

const byLanguageThenNamespace: Record<string, Record<string, Record<string, unknown>>> = {}
for (const [filePath, mod] of Object.entries(localeModules)) {
  const match = filePath.match(LOCALE_PATH_RE)
  if (!match) continue
  const [, code, namespace] = match
  byLanguageThenNamespace[code] ??= {}
  byLanguageThenNamespace[code][namespace] = mod
}

const namespaces = [
  ...new Set(Object.values(byLanguageThenNamespace).flatMap((r) => Object.keys(r))),
].sort()

const targetLanguages = LANGUAGES.map((l) => l.code).filter((code) => code !== SOURCE_LANGUAGE)

function collectKeyPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix]
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
    collectKeyPaths(value, prefix ? `${prefix}.${key}` : key),
  )
}

function getAtPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[segment]
  }, obj)
}

const PLACEHOLDER_NAME_RE = /\{\{\s*(\w+)\s*\}\}/g

function placeholderNames(value: unknown): Set<string> {
  if (typeof value !== 'string') return new Set()
  return new Set([...value.matchAll(PLACEHOLDER_NAME_RE)].map((m) => m[1]))
}

const TAG_TOKEN_RE = /<\/?[\w]+>/g

function tagTokens(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...value.matchAll(TAG_TOKEN_RE)].map((m) => m[0]).sort()
}

const HTML_ENTITY_RE = /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g

function entityTokens(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...value.matchAll(HTML_ENTITY_RE)].map((m) => m[0]).sort()
}

const ALLOWED_PLACEHOLDER_OMISSIONS = new Set<string>([
  'fr/backups.json:mainCard.allSelectedLabel_one',
  'fr/chunkCleaner.json:deleteDialog.title_one',
])

const ALLOWLIST_ENTRY_RE = /^([^/]+)\/([^:]+)\.json:(.+)$/

describe(`locale parity (${SOURCE_LANGUAGE} is the source of truth)`, () => {
  it('every registered language has a locale folder with at least one namespace file', () => {
    for (const code of [SOURCE_LANGUAGE, ...targetLanguages]) {
      expect(byLanguageThenNamespace[code], `no locale files found for registered language "${code}"`).toBeDefined()
    }
  })

  it('ALLOWED_PLACEHOLDER_OMISSIONS has no stale entries (the key must still omit a placeholder its English source supplies)', () => {
    const stale = [...ALLOWED_PLACEHOLDER_OMISSIONS].filter((entry) => {
      const match = entry.match(ALLOWLIST_ENTRY_RE)
      if (!match) return true
      const [, lang, ns, key] = match
      const sourceObj = byLanguageThenNamespace[SOURCE_LANGUAGE]?.[ns] ?? {}
      const targetObj = byLanguageThenNamespace[lang]?.[ns] ?? {}
      const sourceNames = placeholderNames(getAtPath(sourceObj, key))
      const targetNames = placeholderNames(getAtPath(targetObj, key))
      const stillOmitsSomething = [...sourceNames].some((name) => !targetNames.has(name))
      return !stillOmitsSomething
    })
    expect(
      stale,
      'ALLOWED_PLACEHOLDER_OMISSIONS has entries that no longer omit anything their English source supplies — delete them, the exemption is no longer needed',
    ).toEqual([])
  })

  for (const lang of targetLanguages) {
    for (const ns of namespaces) {
      const sourceObj = byLanguageThenNamespace[SOURCE_LANGUAGE]?.[ns] ?? {}
      const targetObj = byLanguageThenNamespace[lang]?.[ns] ?? {}

      it(`${lang}/${ns}.json has exactly the same keys as ${SOURCE_LANGUAGE}/${ns}.json`, () => {
        const sourceKeys = collectKeyPaths(sourceObj).sort()
        const targetKeys = collectKeyPaths(targetObj).sort()

        const missing = sourceKeys.filter((k) => !targetKeys.includes(k))
        const extra = targetKeys.filter((k) => !sourceKeys.includes(k))

        expect(missing, `${lang}/${ns}.json is missing keys present in ${SOURCE_LANGUAGE}`).toEqual([])
        expect(extra, `${lang}/${ns}.json has keys not present in ${SOURCE_LANGUAGE} (stale/typo?)`).toEqual([])
      })

      it(`${lang}/${ns}.json has no empty string values`, () => {
        const emptyKeys = collectKeyPaths(targetObj).filter((path) => getAtPath(targetObj, path) === '')
        expect(emptyKeys, `${lang}/${ns}.json has keys with an empty string value`).toEqual([])
      })

      const sharedKeys = collectKeyPaths(sourceObj).filter((key) => collectKeyPaths(targetObj).includes(key))

      const omittedPlaceholders = sharedKeys.flatMap((key) => {
        if (ALLOWED_PLACEHOLDER_OMISSIONS.has(`${lang}/${ns}.json:${key}`)) return []
        const sourceNames = placeholderNames(getAtPath(sourceObj, key))
        const targetNames = placeholderNames(getAtPath(targetObj, key))
        return [...sourceNames].filter((name) => !targetNames.has(name)).map((name) => `${key}: {{${name}}}`)
      })
      const introducedPlaceholders = sharedKeys.flatMap((key) => {
        const sourceNames = placeholderNames(getAtPath(sourceObj, key))
        const targetNames = placeholderNames(getAtPath(targetObj, key))
        return [...targetNames].filter((name) => !sourceNames.has(name)).map((name) => `${key}: {{${name}}}`)
      })
      const tagMismatches = sharedKeys.flatMap((key) => {
        const sourceTags = tagTokens(getAtPath(sourceObj, key))
        const targetTags = tagTokens(getAtPath(targetObj, key))
        if (JSON.stringify(sourceTags) === JSON.stringify(targetTags)) return []
        return [`${key}: ${SOURCE_LANGUAGE}=${JSON.stringify(sourceTags)} vs ${lang}=${JSON.stringify(targetTags)}`]
      })
      const entityMismatches = sharedKeys.flatMap((key) => {
        const sourceEntities = entityTokens(getAtPath(sourceObj, key))
        const targetEntities = entityTokens(getAtPath(targetObj, key))
        if (JSON.stringify(sourceEntities) === JSON.stringify(targetEntities)) return []
        return [
          `${key}: ${SOURCE_LANGUAGE}=${JSON.stringify(sourceEntities)} vs ${lang}=${JSON.stringify(targetEntities)}`,
        ]
      })

      it(`${lang}/${ns}.json supplies every {{placeholder}} that ${SOURCE_LANGUAGE}/${ns}.json uses for the same key`, () => {
        expect(
          omittedPlaceholders,
          `${lang}/${ns}.json drops a placeholder ${SOURCE_LANGUAGE} supplies for that key — nothing will fill it at render time`,
        ).toEqual([])
      })

      it(`${lang}/${ns}.json does not introduce a {{placeholder}} that ${SOURCE_LANGUAGE}/${ns}.json does not supply for the same key`, () => {
        expect(
          introducedPlaceholders,
          `${lang}/${ns}.json uses a placeholder ${SOURCE_LANGUAGE} never supplies for that key — it will render as the literal "{{name}}" text`,
        ).toEqual([])
      })

      it(`${lang}/${ns}.json has the same multiset of HTML/Trans tags as ${SOURCE_LANGUAGE}/${ns}.json for the same key`, () => {
        expect(
          tagMismatches,
          `${lang}/${ns}.json has a tag mismatch vs ${SOURCE_LANGUAGE}/${ns}.json (missing/extra/escaped <tag>)`,
        ).toEqual([])
      })

      it(`${lang}/${ns}.json has the same multiset of HTML entities as ${SOURCE_LANGUAGE}/${ns}.json for the same key`, () => {
        expect(
          entityMismatches,
          `${lang}/${ns}.json has an HTML-entity mismatch vs ${SOURCE_LANGUAGE}/${ns}.json (a literal character got escaped, e.g. "&" became "&amp;", and will render as literal entity text on screen)`,
        ).toEqual([])
      })
    }
  }
})
