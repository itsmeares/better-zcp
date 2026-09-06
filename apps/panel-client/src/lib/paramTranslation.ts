import i18n, { getCurrentLanguage } from '@/i18n'

export type TranslationParams = Record<string, string | number>

const PLACEHOLDER_NAME_RE = /\{\{\s*(\w+)\s*\}\}/g

function requiredParamNames(template: string): string[] {
  const names = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER_NAME_RE)) {
    names.add(match[1])
  }
  return [...names]
}

// Strict by design: any params shape other than a flat string|number map is
// treated as entirely absent, never partially trusted. A param that's
// present but wrong-typed must behave exactly like a missing one — see
// resolveRegisteredTranslation for why.
export function extractTranslationParams(candidate: unknown): TranslationParams | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined

  const out: TranslationParams = {}
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
  }
  return out
}

// Only trust a registered translation when it needs no interpolation data
// we don't have. Several locale entries carry a {{placeholder}} for data
// the server doesn't always send as structured params — translating one
// without a value would put the literal text "{{name}}" in front of a
// user, which is worse than the untranslated passthrough it would replace.
// This is the backstop shared by every consumer of this module: a key with
// no placeholders translates unconditionally; a key with placeholders only
// translates once every required name is present in `params` with a
// usable (string|number) value, and returns null (the caller's fallback)
// otherwise. `resolveParamValue`, when given, lets a caller translate a
// param's VALUE through a second lookup before interpolating (see
// errorMessage.ts's capability-key resolution) — it must return the raw
// value unchanged for anything it doesn't specifically know how to resolve.
export function resolveRegisteredTranslation(
  ns: string,
  key: string,
  params: TranslationParams | undefined,
  resolveParamValue?: (name: string, value: string | number) => string | number,
): string | null {
  if (!i18n.exists(key, { ns })) return null

  const template = i18n.getResource(getCurrentLanguage(), ns, key)
  if (typeof template !== 'string') return null

  const required = requiredParamNames(template)
  if (required.length === 0) return i18n.t(key, { ns })

  const available = params ?? {}
  if (!required.every((name) => Object.prototype.hasOwnProperty.call(available, name))) return null

  const resolved: TranslationParams = {}
  for (const name of required) {
    const value = available[name]
    resolved[name] = resolveParamValue ? resolveParamValue(name, value) : value
  }
  return i18n.t(key, { ns, ...resolved })
}
