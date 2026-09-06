import i18n from '@/i18n'
import type { AutoUpdateResult } from './api'

type TFn = (key: string, opts?: Record<string, unknown>) => string

export function getAutoUpdateServerStateMessage(t: TFn, serverUp: boolean | null | undefined): string {
  const key = serverUp === true
    ? 'autoUpdateResult.serverUp'
    : serverUp === false
      ? 'autoUpdateResult.serverDown'
      : 'autoUpdateResult.serverUnaffected'
  return t(key, { ns: 'dashboard' })
}

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
