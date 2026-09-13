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

export function translateDiagnosticCheck(
  check: DiagnosticCheckLike,
): TranslatedDiagnosticCheck {
  return {
    label: check.label,
    message: check.message,
    hint: check.hint ?? undefined,
  }
}
