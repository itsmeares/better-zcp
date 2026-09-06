import { extractTranslationParams, resolveRegisteredTranslation } from './paramTranslation'

// Shape returned by GET /api/debug/diagnostics (apps/panel-server/routes/debug.js,
// diagOk/diagFail/diagWarn/diagSkip/diagInfo). `label`/`message`/`hint` are
// always present as server-built English text — a registered translation,
// when one exists and its params check out, is used instead; the English
// fields are never removed from the response, so an older client (or a
// check id with no locale entry yet) keeps working unchanged.
export interface DiagnosticCheckLike {
  id: string
  status: string
  label: string
  message: string
  hint?: string | null
  params?: unknown
  // Set only when the same id+status covers two or more genuinely
  // different sentences (not just different data in one template) — e.g.
  // server.installPath's "not found" is a different explanation for a
  // network mount than for a plain local path. Always a server-chosen
  // literal from a small closed set (never user input), safe to use
  // directly as a locale key segment.
  variant?: string | null
}

export interface TranslatedDiagnosticCheck {
  label: string
  message: string
  hint: string | undefined
}

// Diagnostic check ids are already dot-separated (`"server.process"`,
// `"mods.resolved"`) and become real, deliberate i18next nesting under
// debug.json's diagnostics.checks tree — `diagnostics.checks.<id>.<status>
// [.<variant>].<field>` — not a synthesized key. Each of label/message/hint
// resolves independently through the same params-or-fallback guard as
// errorMessage.ts (resolveRegisteredTranslation): missing/malformed params
// falls back to the server's own English text for that field, never a raw
// {{placeholder}}. `check` itself (with its original English hint) must
// still be used for any fix-action / hint-text matching logic — only the
// returned label/message/hint are for display.
//
// A variant entry is always complete and self-contained (its own label +
// message, +hint if that status has one) — never a partial override that
// falls back to the plain (non-variant) entry for a field it omits. That
// keeps the id+status+variant space exhaustively enumerable for
// apps/panel-server/tests/diagnosticsCheckRegistry.test.js: every combination the
// handler can emit either has a full locale entry or it doesn't: no
// "depends which field" ambiguity to also encode in that test.
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
