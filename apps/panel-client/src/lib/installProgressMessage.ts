import { extractTranslationParams, resolveRegisteredTranslation, type TranslationParams } from './paramTranslation'

// Client-side half of apps/panel-server/utils/progressCodes.js's ProgressCode registry.
// Mirrors apps/panel-client/src/lib/errorMessage.ts's shape (same reused
// resolveRegisteredTranslation() machinery, different namespace) rather than
// a second implementation -- see that registry's file header for why this
// is a separate namespace/field name (`progressCode`, not `code`) instead
// of folding into errors.json.
//
// THE FALLBACK IS THE DISCRIMINATOR: a Socket.IO payload with no
// progressCode is always a raw SteamCMD passthrough line (server.js's
// emitRawSteamCmdLine() cannot attach one) -- getInstallProgressMessage()
// returns `fallback` unchanged for those, same as it does for an authored
// line whose code/params can't yet be resolved (translation missing,
// params incomplete). Callers should always pass the server's own
// message/text field as `fallback`.
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
