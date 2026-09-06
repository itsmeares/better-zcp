import { extractTranslationParams, resolveRegisteredTranslation, type TranslationParams } from './paramTranslation'

export interface InstallProgressPayload {
  progressCode?: unknown
  params?: unknown
}

export function getInstallProgressMessage(payload: InstallProgressPayload, fallback: string): string {
  const code = typeof payload.progressCode === 'string' && payload.progressCode ? payload.progressCode : undefined
  if (!code) return fallback

  const params: TranslationParams | undefined = extractTranslationParams(payload.params)
  const translated = resolveRegisteredTranslation('installProgress', code, params)
  return translated ?? fallback
}
