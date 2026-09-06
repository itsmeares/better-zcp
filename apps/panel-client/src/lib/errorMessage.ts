import { ApiError } from './api'
import i18n from '@/i18n'
import { extractTranslationParams, resolveRegisteredTranslation, type TranslationParams } from './paramTranslation'

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

function extractErrorParams(error: unknown): TranslationParams | undefined {
  const data = error instanceof ApiError ? error.data : undefined
  if (!data || typeof data !== 'object' || !('params' in data)) return undefined
  return extractTranslationParams((data as { params?: unknown }).params)
}

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

const GENERIC_SERVER_ERROR_KEY = 'UNEXPECTED_SERVER_ERROR'
const GENERIC_SERVER_ERROR_STATUS_FLOOR = 500

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

export function rawErrorMessageIntentional(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function getRecoveryUrl(error: unknown): string | null {
  const payload = error instanceof ApiError && error.data && typeof error.data === 'object'
    ? error.data as { fixUrl?: unknown }
    : null
  if (typeof payload?.fixUrl === 'string' && payload.fixUrl.startsWith('/')) {
    return payload.fixUrl
  }

  const code = error instanceof ApiError ? error.code : undefined
  if (code === 'RCON_CONNECT_AUTH_FAILED') return '/servers'
  if (code === 'RCON_CONNECT_UNREACHABLE') return null

  const message = error instanceof Error ? error.message : String(error || '')
  if (/rcon|connection refused|authentication failed/i.test(message)) return '/servers'
  if (/panelbridge|bridge not running|bridge not configured/i.test(message)) return '/settings?tab=bridge'
  if (/no active server|no server configured/i.test(message)) return '/servers'
  if (/eacces|permission denied/i.test(message)) return '/servers'
  return null
}
