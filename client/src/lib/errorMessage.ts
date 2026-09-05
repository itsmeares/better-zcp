import { ApiError } from './api'
import i18n from '@/i18n'
import { extractTranslationParams, resolveRegisteredTranslation, type TranslationParams } from './paramTranslation'

// server/utils/errorCodes.js: 8 pre-i18n error codes ship a frozen
// lower_snake_case wire value that client code already compares with ===
// elsewhere (see that file's own comments for why it can't be renamed),
// while their errors.json locale key is the UPPER_SNAKE_CASE constant
// name invented only so a translation could exist. Mirrored here as a
// static, literal table — never synthesized — so a translated wire value
// stays grep-able the same way the server-side registry requires.
const LEGACY_WIRE_CODE_TO_LOCALE_KEY: Readonly<Record<string, string>> = {
  server_running: 'SERVER_RUNNING_LEGACY',
  docker_updater_not_configured: 'DOCKER_UPDATER_NOT_CONFIGURED_LEGACY',
  apply_in_progress: 'APPLY_IN_PROGRESS_LEGACY',
  already_downloading: 'ALREADY_DOWNLOADING_LEGACY',
  no_update: 'NO_UPDATE_LEGACY',
  confirmation_required: 'CONFIRMATION_REQUIRED_LEGACY',
  save_failed: 'SAVE_FAILED_LEGACY',
  stop_failed: 'STOP_FAILED_LEGACY',
}

function extractErrorCode(error: unknown): string | undefined {
  if (error instanceof ApiError && typeof error.code === 'string' && error.code) {
    return error.code
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const candidate = (error as { code?: unknown }).code
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return undefined
}

// Extracts the optional structured `params` sibling the server sends
// alongside `error`/`code` for the handful of errors.json entries that
// carry a {{placeholder}} (a role name, a capability, a save-failure
// reason, ...).
function extractErrorParams(error: unknown): TranslationParams | undefined {
  const data = error instanceof ApiError ? error.data : undefined
  if (!data || typeof data !== 'object' || !('params' in data)) return undefined
  return extractTranslationParams((data as { params?: unknown }).params)
}

// A small, closed set of param names whose value is a stable capability
// key (e.g. "roles.manage") rather than free text — the server can't know
// the operator's language, so it sends the key and the client resolves it
// through the same capabilities.<key>.label catalogue RolesPermissions.tsx
// already renders the matrix from (client/src/locales/*/roles.json). Not
// applied to every param (a role or backup NAME could coincidentally look
// like a capability key) — only to the param names that are actually
// documented to carry one. Falls back to the raw value when there's no
// matching label (e.g. INVALID_CAPABILITY's `capability` param is, by
// definition, never a real registered key).
const CAPABILITY_KEY_PARAM_NAMES = new Set(['action', 'capability'])

function resolveParamValue(name: string, value: string | number): string | number {
  if (typeof value !== 'string' || !CAPABILITY_KEY_PARAM_NAMES.has(name)) return value
  const labelKey = `capabilities.${value}.label`
  if (!i18n.exists(labelKey, { ns: 'roles' })) return value
  return i18n.t(labelKey, { ns: 'roles' })
}

function getRegisteredTranslation(code: string, params: TranslationParams | undefined): string | null {
  const key = LEGACY_WIRE_CODE_TO_LOCALE_KEY[code] ?? code
  return resolveRegisteredTranslation('errors', key, params, resolveParamValue)
}

// A failed fetch may have a code that has no registered translation. For 5xx
// responses, wrap the preserved detail in the generic server-error message;
// leave deliberate 4xx validation text unchanged.
const GENERIC_SERVER_ERROR_KEY = 'UNEXPECTED_SERVER_ERROR'
const GENERIC_SERVER_ERROR_STATUS_FLOOR = 500

// Normalize the detail before interpolation so messages with and without
// terminal punctuation render as separate sentences in every locale.
const SENTENCE_TERMINATOR_RE = /[.!?]["')\]]*$/

function wrapUncodedServerError(status: number | undefined, message: string): string | null {
  if (typeof status !== 'number' || status < GENERIC_SERVER_ERROR_STATUS_FLOOR) return null
  const detail = SENTENCE_TERMINATOR_RE.test(message) ? message : `${message}.`
  return resolveRegisteredTranslation('errors', GENERIC_SERVER_ERROR_KEY, { detail })
}

export function getUserErrorMessage(error: unknown, fallback: string): string {
  const code = extractErrorCode(error)
  const params = extractErrorParams(error)
  const translated = code ? getRegisteredTranslation(code, params) : null
  if (translated) return translated

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
    if (typeof candidate === 'string' && candidate.trim() && candidate.toLowerCase() !== 'unknown error') {
      return candidate.trim()
    }
  }

  return fallback
}

// Named escape hatch for the rare call site that intentionally needs raw
// error text instead of translated messaging.
export function rawErrorMessageIntentional(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

// HARD CONSTRAINT: every destination this function can return must be an
// internal path (enforced below by requiring a leading "/") -- never build
// this from anything the server sends as free text, and never loosen the
// payload.fixUrl check. A response body is attacker-influenced in principle;
// letting it name an external URL would let a compromised or malicious
// server response redirect a signed-in admin's browser somewhere off this
// origin. If a destination can't be expressed as one of the fixed literal
// paths below, it doesn't belong in this function.
export function getRecoveryUrl(error: unknown): string | null {
  const payload = error instanceof ApiError && error.data && typeof error.data === 'object'
    ? error.data as { fixUrl?: unknown }
    : null
  if (typeof payload?.fixUrl === 'string' && payload.fixUrl.startsWith('/')) {
    return payload.fixUrl
  }

  // Code-based first, and authoritative when present: these two codes come
  // from the SAME failed RCON handshake (server/routes/rcon.js POST
  // /connect and /test, and server/routes/config.js POST /test-rcon) and
  // mean two different things a message-only guess
  // below can't tell apart. Auth-failed is genuinely fixable from Servers
  // (the RCON password field lives there). Unreachable is an install-level
  // problem -- server not running, firewall never opened, wrong host/port
  // -- that no in-app screen can fix by being opened, so it deliberately
  // returns null instead of falling through to the message regex, which
  // would otherwise match "RCON" in either message and offer a link that
  // does nothing for the unreachable case.
  const code = error instanceof ApiError ? error.code : undefined
  if (code === 'RCON_CONNECT_AUTH_FAILED') return '/servers'
  if (code === 'RCON_CONNECT_UNREACHABLE') return null

  const message = error instanceof Error ? error.message : String(error || '')
  // Not /settings?tab=connection: that tab is test-and-reconnect-settings
  // only now, and its own copy (settings.json connection.cardDesc) sends the
  // reader straight back to Servers -- host/port/password are per-server
  // fields there. Pointing here directly skips that dead-end hop.
  if (/rcon|connection refused|authentication failed/i.test(message)) return '/servers'
  if (/panelbridge|bridge not running|bridge not configured/i.test(message)) return '/settings?tab=bridge'
  if (/no active server|no server configured/i.test(message)) return '/servers'
  // EACCES/permission-denied: server/routes/server.js's formatDirectoryReadError
  // produces "Cannot read <path> (EACCES). ..." for an unreadable configured
  // PZ install or Zomboid data path -- both are per-server fields on Servers,
  // same as RCON. Not every EACCES is fixable from there (the panel's own
  // /app/data or /app/logs mount is a container-level path with no settings
  // field at all), but a per-server install/data path is the far more common
  // real-world trigger, and Servers is where a fixable one actually lives.
  if (/eacces|permission denied/i.test(message)) return '/servers'
  return null
}
