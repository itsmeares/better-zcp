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

export function extractTranslationParams(candidate: unknown): TranslationParams | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined

  const out: TranslationParams = {}
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
  }
  return out
}

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
