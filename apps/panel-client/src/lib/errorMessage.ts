import { ApiError } from './ApiError'
const GENERIC_SERVER_ERROR_STATUS_FLOOR = 500

const SENTENCE_TERMINATOR_RE = /[.!?]["')\]]*$/

function wrapUncodedServerError(
  status: number | undefined,
  message: string,
): string | null {
  if (typeof status !== 'number' || status < GENERIC_SERVER_ERROR_STATUS_FLOOR)
    return null
  const detail = SENTENCE_TERMINATOR_RE.test(message) ? message : `${message}.`
  return `${detail} This wasn't expected — if it keeps happening, download a support bundle so it can be investigated.`
}

export function getUserErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const message = error.message?.trim()
    if (message && message.toLowerCase() !== 'unknown error') {
      return wrapUncodedServerError(error.status, message) ?? message
    }
    return fallback
  }

  if (error instanceof Error) {
    const message = error.message?.trim()
    if (message && message.toLowerCase() !== 'unknown error') {
      return message
    }
    return fallback
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const candidate = (error as { message?: unknown }).message
    if (
      typeof candidate === 'string' &&
      candidate.trim() &&
      candidate.toLowerCase() !== 'unknown error'
    ) {
      return candidate.trim()
    }
  }

  return fallback
}

export function rawErrorMessageIntentional(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** The page whose settings can fix this error, if one can. */
export function getRecoveryUrl(error: unknown): string | null {
  const code = error instanceof ApiError ? error.code : undefined
  if (code === 'RCON_CONNECT_AUTH_FAILED') return '/server-settings'
  if (code === 'RCON_CONNECT_UNREACHABLE') return null

  const message = error instanceof Error ? error.message : String(error || '')
  if (/rcon|connection refused|authentication failed/i.test(message))
    return '/server-settings'
  if (/game integration|game-integration|integration not running|integration not configured/i.test(message))
    return '/server-settings'
  if (/no active server|no server configured/i.test(message)) return '/servers'
  if (/eacces|permission denied/i.test(message)) return '/server-settings'
  return null
}
