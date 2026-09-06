import i18n from '@/i18n'
import type { AutoUpdateResult } from './api'

type TFn = (key: string, opts?: Record<string, unknown>) => string

// 2026-08-26: serverUp is recorded server-side per PHASE (before-stop /
// updating / restarting), not inferred per failure reason -- see
// updateChecker.js's own comment on why. true/false/null map onto the
// three things an operator actually needs to know: still up, currently
// down, or nothing was touched at all.
export function getAutoUpdateServerStateMessage(t: TFn, serverUp: boolean | null | undefined): string {
  const key = serverUp === true
    ? 'autoUpdateResult.serverUp'
    : serverUp === false
      ? 'autoUpdateResult.serverDown'
      : 'autoUpdateResult.serverUnaffected'
  return t(key, { ns: 'dashboard' })
}

// A stable reason key (never the server's raw message) resolved to
// translated copy, with `params` interpolated the same way every other
// coded failure in this app is. Falls back to a generic message rather
// than a raw/untranslated key if `reason` doesn't match a known one --
// this is a closed, self-defined set (unlike the server ErrorCode
// registry), so an unmatched value means the two sides drifted, not that
// the server sent something unexpected.
export function getAutoUpdateReasonMessage(t: TFn, result: AutoUpdateResult): string {
  const reason = result.reason || 'UNKNOWN'
  const key = `autoUpdateResult.reasons.${reason}`
  if (i18n.exists(key, { ns: 'dashboard' })) {
    return t(key, { ns: 'dashboard', ...(result.params || {}) })
  }
  return t('autoUpdateResult.reasons.UNKNOWN', { ns: 'dashboard' })
}

export function getAutoUpdateSuccessMessage(t: TFn, result: AutoUpdateResult): string {
  if (result.appliedVersion) {
    return t('autoUpdateResult.successDescriptionVersioned', { ns: 'dashboard', version: result.appliedVersion })
  }
  return t('autoUpdateResult.successDescription', { ns: 'dashboard' })
}
