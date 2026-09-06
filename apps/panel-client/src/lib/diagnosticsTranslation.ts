import { extractTranslationParams, resolveRegisteredTranslation } from './paramTranslation'

export interface DiagnosticCheckLike {
  id: string
  status: string
  label: string
  message: string
  hint?: string | null
  params?: unknown
  variant?: string | null
}

export interface TranslatedDiagnosticCheck {
  label: string
  message: string
  hint: string | undefined
}

export function translateDiagnosticCheck(check: DiagnosticCheckLike): TranslatedDiagnosticCheck {
  const params = extractTranslationParams(check.params)
  const base = check.variant
    ? `diagnostics.checks.${check.id}.${check.status}.${check.variant}`
    : `diagnostics.checks.${check.id}.${check.status}`

  const label = resolveRegisteredTranslation('debug', `${base}.label`, params) ?? check.label
  const message = resolveRegisteredTranslation('debug', `${base}.message`, params) ?? check.message
  const hint = check.hint
    ? (resolveRegisteredTranslation('debug', `${base}.hint`, params) ?? check.hint)
    : undefined

  return { label, message, hint }
}
