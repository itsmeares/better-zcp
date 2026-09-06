import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { ApiError } from '../api'
import { getRecoveryUrl, getUserErrorMessage } from '../errorMessage'

describe('getRecoveryUrl', () => {
  it('uses the server-provided recovery destination', () => {
    expect(getRecoveryUrl(new ApiError('Bridge not running', { data: { fixUrl: '/settings?tab=bridge' } }))).toBe('/settings?tab=bridge')
  })

  it('never returns a destination that is not an internal path, even if fixUrl tries to supply one', () => {
    expect(getRecoveryUrl(new ApiError('Some unrelated failure', { data: { fixUrl: 'https://evil.example/phish' } }))).toBeNull()
  })

  // Not /settings?tab=connection: that tab's own copy (settings.json
  // connection.cardDesc) says host/port/password are per-server fields on
  // Servers now -- pointing there was one extra, unhelpful hop.
  it('maps established RCON failures (by message, no code available) to Servers', () => {
    expect(getRecoveryUrl(new Error('RCON authentication failed'))).toBe('/servers')
  })

  it('routes a code-classified RCON auth failure to Servers, where the password field lives', () => {
    expect(getRecoveryUrl(new ApiError('Connected to the server, but authentication failed. Check the RCON password in server settings.', { code: 'RCON_CONNECT_AUTH_FAILED' }))).toBe('/servers')
  })

  it('gives no destination for a code-classified RCON unreachable failure -- no settings screen fixes a closed firewall or a stopped server', () => {
    expect(getRecoveryUrl(new ApiError('Could not connect to RCON. Is the server running and RCON enabled?', { code: 'RCON_CONNECT_UNREACHABLE' }))).toBeNull()
  })

  it('prefers the code classification over the message even though the unreachable message also contains "RCON"', () => {
    // Without the code check running first, this would match the same
    // message regex the auth-failed case does and wrongly offer a fix-it
    // link for a problem no settings page can fix.
    const error = new ApiError('Could not connect to RCON. Is the server running and RCON enabled?', { code: 'RCON_CONNECT_UNREACHABLE' })
    expect(getRecoveryUrl(error)).not.toBe('/servers')
  })

  it('routes a permission-denied (EACCES) failure to Servers, where per-server install/data paths live', () => {
    expect(getRecoveryUrl(new Error('Cannot read /srv/pz (EACCES). The panel service account needs read and execute permission on this folder and every parent folder.'))).toBe('/servers')
  })

  it('does not create a destination for unrelated failures', () => {
    expect(getRecoveryUrl(new Error('Network timeout'))).toBeNull()
  })
})

class MockApiError extends Error {
  status?: number
  code?: string
  isRetryable = false
  isTimeout = false
  isNetworkError = false

  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

describe('getUserErrorMessage', () => {
  it('returns the error message for a standard Error', () => {
    expect(getUserErrorMessage(new Error('Connection lost'), 'fallback')).toBe('Connection lost')
  })

  it('returns fallback for empty error message', () => {
    expect(getUserErrorMessage(new Error(''), 'Something went wrong')).toBe('Something went wrong')
  })

  it('returns fallback for "unknown error" message (case-insensitive)', () => {
    expect(getUserErrorMessage(new Error('Unknown Error'), 'fallback')).toBe('fallback')
  })

  it('returns fallback for non-error objects without message', () => {
    expect(getUserErrorMessage(42, 'fallback')).toBe('fallback')
    expect(getUserErrorMessage(null, 'fallback')).toBe('fallback')
    expect(getUserErrorMessage(undefined, 'fallback')).toBe('fallback')
  })

  it('extracts message from plain objects with message property', () => {
    expect(getUserErrorMessage({ message: 'server down' }, 'fallback')).toBe('server down')
  })

  it('returns fallback for plain objects with empty message', () => {
    expect(getUserErrorMessage({ message: '' }, 'fallback')).toBe('fallback')
  })
})

describe('getUserErrorMessage — error.code translation priority', () => {
  beforeEach(() => {
    void i18n.changeLanguage('fr')
  })

  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('prefers the registered translation over the server-provided English text', () => {
    const error = new ApiError('No active server configured', { code: 'SERVER_NOT_CONFIGURED' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Aucun serveur actif configuré')
  })

  it('maps a frozen legacy lower_snake_case wire code to its _LEGACY locale key', () => {
    const error = new ApiError('Stop the server before deleting chunks.', { code: 'server_running' })
    expect(getUserErrorMessage(error, 'fallback')).toContain('supprimer des chunks')
  })

  it('falls through to the server message when the code has no registered translation', () => {
    const error = new ApiError('Something very specific went wrong', { code: 'SOME_UNREGISTERED_CODE' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Something very specific went wrong')
  })

  it('falls through to the server message (unchanged from today) when the registered translation needs interpolation data the client does not have', () => {
    const error = new ApiError('A role named "Moderator" already exists', { code: 'ROLE_NAME_TAKEN' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('A role named "Moderator" already exists')
  })

  it('never surfaces an unresolved {{placeholder}} to the user', () => {
    const error = new ApiError('A role named "Moderator" already exists', { code: 'ROLE_NAME_TAKEN' })
    expect(getUserErrorMessage(error, 'fallback')).not.toMatch(/\{\{/)
  })

  it('still uses the fallback for an untranslated code with no server message', () => {
    const error = new ApiError('', { code: 'SOME_UNREGISTERED_CODE' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('fallback')
  })

  it('translation lookup does not affect English (the default fallback language)', () => {
    void i18n.changeLanguage('en')
    const error = new ApiError('No active server configured', { code: 'SERVER_NOT_CONFIGURED' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('No active server configured')
  })
})

describe('getUserErrorMessage — structured params interpolation', () => {
  beforeEach(() => {
    void i18n.changeLanguage('fr')
  })

  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('interpolates a registered translation once the server sends the matching param', () => {
    const error = new ApiError('A role named "Moderator" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: { name: 'Moderator' } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Un rôle nommé « Moderator » existe déjà')
  })

  it('interpolates a numeric param', () => {
    const error = new ApiError('3 user(s) still hold this role.', {
      code: 'ROLE_HAS_MEMBERS',
      data: { params: { count: 3 } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe(
      "Ce rôle est encore détenu par 3 utilisateur(s). Indiquez reassignTo pour les réattribuer à un autre rôle d'abord.",
    )
  })

  it('resolves an action param through the capabilities label catalogue instead of showing the raw key', () => {
    const error = new ApiError('This change would leave no user able to manage roles.', {
      code: 'ROLE_LOCKOUT_LAST_MANAGER',
      data: { params: { action: 'roles.manage' } },
    })
    const message = getUserErrorMessage(error, 'fallback')
    expect(message).not.toContain('roles.manage')
    expect(message).not.toContain('{{')
    expect(message).toContain('Gérer les rôles et permissions')
  })

  it('falls back to the raw value for a capability param with no matching label (e.g. an invalid capability)', () => {
    const error = new ApiError('Unknown capability: not.a.real.capability', {
      code: 'INVALID_CAPABILITY',
      data: { params: { capability: 'not.a.real.capability' } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Capacité inconnue : not.a.real.capability')
  })

  it('does not resolve capability labels for param names outside the closed list (e.g. name)', () => {
    const error = new ApiError('A role named "roles.manage" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: { name: 'roles.manage' } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Un rôle nommé « roles.manage » existe déjà')
  })

  it('falls through to the server text when params is missing the required key (malformed, not just absent)', () => {
    const error = new ApiError('A role named "Moderator" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: { wrongKey: 'Moderator' } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('A role named "Moderator" already exists')
  })

  it('falls through to the server text when params has the right key but a non-string/number value', () => {
    const error = new ApiError('A role named "Moderator" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: { name: { nested: 'Moderator' } } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('A role named "Moderator" already exists')
  })

  it('falls through to the server text when params itself is not an object (array)', () => {
    const error = new ApiError('A role named "Moderator" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: ['Moderator'] },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('A role named "Moderator" already exists')
  })

  // 2026-08-26: panelBridgeSftp.js's formatSftpError() built its "{{detail}}
  // Fix: ..." classification as a parallel, English-only system that never
  // fed into this registry. These lock in that the move preserved the exact
  // dynamic detail the English version carried (the raw SFTP client error
  // text) via {{detail}}, and that a response which forgets to send it degrades
  // to the untranslated server text rather than a broken "{{detail}}" literal --
  // same guarantee ROLE_NAME_TAKEN's tests above prove for {{name}}.
  it('interpolates the original SFTP error text into the translated classification', () => {
    const error = new ApiError('Permission denied (publickey). Fix: Verify the SFTP username and password, then confirm the account can log in over port 22.', {
      code: 'SFTP_AUTH_FAILED',
      data: { params: { detail: 'Permission denied (publickey).' } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe(
      "Permission denied (publickey). Correction : Vérifiez le nom d'utilisateur et le mot de passe SFTP, puis confirmez que le compte peut se connecter sur le port 22.",
    )
  })

  it('falls through to the raw English text when an SFTP response omits params.detail', () => {
    const error = new ApiError('Permission denied (publickey). Fix: Verify the SFTP username and password, then confirm the account can log in over port 22.', {
      code: 'SFTP_AUTH_FAILED',
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe(
      'Permission denied (publickey). Fix: Verify the SFTP username and password, then confirm the account can log in over port 22.',
    )
  })
})

// 2026-08-26: panelBridge.js's 76-of-88 generic catch-all shape (server.js
// has the same convention: 500s stay uncoded by design, only explicit
// validation branches get a code). api.ts synthesizes `code: HTTP_<status>`
// for any response missing one, so these exercise via a real fetched shape
// (status set, no *registered* translation resolves) rather than a bare
// `code: undefined` a real network response would never actually produce.
describe('getUserErrorMessage — generic wrapper for an uncoded 5xx', () => {
  beforeEach(() => {
    void i18n.changeLanguage('fr')
  })

  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('wraps a 500 with no registered code translation, preserving the raw detail', () => {
    const error = new ApiError('EACCES: permission denied, open [path]', { status: 500, code: 'HTTP_500' })
    // bug-hunt-2026-08-31: the raw detail doesn't end in terminal
    // punctuation, so wrapUncodedServerError appends a period before
    // interpolating -- without it this read as one run-on sentence with no
    // boundary ("...open [path] Ce n'était pas attendu...").
    expect(getUserErrorMessage(error, 'fallback')).toBe(
      "EACCES: permission denied, open [path]. Ce n'était pas attendu — si cela persiste, téléchargez un pack de support afin qu'il puisse être examiné.",
    )
  })

  it('does not double the punctuation when the raw detail already ends in a sentence terminator', () => {
    const error = new ApiError('Request failed.', { status: 500, code: 'HTTP_500' })
    expect(getUserErrorMessage(error, 'fallback')).toBe(
      "Request failed. Ce n'était pas attendu — si cela persiste, téléchargez un pack de support afin qu'il puisse être examiné.",
    )
  })

  it('also wraps other 5xx statuses (e.g. 503, 504), not just 500', () => {
    const error = new ApiError('upstream timed out', { status: 504, code: 'HTTP_504' })
    expect(getUserErrorMessage(error, 'fallback')).toContain("n'était pas attendu")
  })

  it('does NOT wrap a 4xx with no registered code -- deliberate validation text stays untouched', () => {
    const error = new ApiError('Username is required', { status: 400, code: 'HTTP_400' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Username is required')
  })

  it('does not wrap when a real code already resolves a translation, even at 5xx', () => {
    const error = new ApiError('Update checker not available', { status: 503, code: 'UPDATE_CHECKER_NOT_AVAILABLE' })
    expect(getUserErrorMessage(error, 'fallback')).toBe("Le vérificateur de mises à jour n'est pas disponible")
  })

  it('is a no-op in English (the wrapper text would be identical to a hand-written one, so assert it is present rather than absent)', () => {
    void i18n.changeLanguage('en')
    const error = new ApiError('ECONNREFUSED', { status: 500, code: 'HTTP_500' })
    expect(getUserErrorMessage(error, 'fallback')).toBe(
      "ECONNREFUSED. This wasn't expected — if it keeps happening, download a support bundle so it can be investigated.",
    )
  })
})
