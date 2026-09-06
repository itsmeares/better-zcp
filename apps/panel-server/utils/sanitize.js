/**
 * Sanitize error messages before sending to clients.
 * Strips filesystem paths and other sensitive info that could aid attackers.
 */

// Matches any settings/config key that holds a credential-shaped value.
// Pattern-based (rather than an explicit key allowlist) so a newly added
// secret (e.g. jwtSecret, discordBotToken) is masked automatically instead
// of leaking until someone remembers to add it to a list.
export const SENSITIVE_FIELD_RE =
  /password|secret|token|apikey|api_key|jwt|sessionid|loginsecure|cookie|webhook/i;

/**
 * Detect a value that is just the bullet-mask sentinel we send to clients
 * (see maskSecretValue/maskSensitiveObject below). Used to avoid writing the
 * masked placeholder back over a real stored secret when a client echoes an
 * unmodified masked field back on save.
 */
export function isMaskedSecret(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("••••••••")) return true;
  if (/^[•*●○]+$/.test(value)) return true;
  return false;
}

/** Mask a secret string, keeping only its last 4 characters for reference. */
export function maskSecretValue(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return "••••••••" + value.slice(-4);
}

/**
 * Shallow-mask every string field whose key looks secret-like
 * (SENSITIVE_FIELD_RE). Used for API responses that echo back settings or
 * DB records containing credentials (RCON/admin passwords, tokens, cookies).
 */
export function maskSensitiveObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const masked = { ...obj };
  for (const [key, value] of Object.entries(masked)) {
    if (SENSITIVE_FIELD_RE.test(key) && typeof value === "string" && value) {
      masked[key] = maskSecretValue(value);
    }
  }
  return masked;
}

/**
 * Drop every field whose key looks secret-like (SENSITIVE_FIELD_RE) instead
 * of masking its value. Use this where the result can be WRITTEN BACK
 * somewhere a masked placeholder string would corrupt (e.g. persisted into a
 * config snapshot that a later "apply" writes verbatim into a live file) --
 * maskSensitiveObject()'s placeholder is only safe for values that are
 * strictly DISPLAYED, never replayed.
 */
export function omitSensitiveFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELD_RE.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Mask a single server record's credentials (rconPassword, adminPassword,
 * ...) before it goes out over the API. Every /api/servers response —
 * list, single, create, update, activate, detect, auto-scan — must go
 * through this so a non-admin authenticated user (or a compromised
 * frontend origin) can't read a running server's RCON/admin password.
 */
export function sanitizeServerResponse(server) {
  return maskSensitiveObject(server);
}

/** Map sanitizeServerResponse over an array of server records. */
export function sanitizeServerResponseList(servers) {
  return Array.isArray(servers) ? servers.map(sanitizeServerResponse) : servers;
}

// Matches Windows absolute paths like C:\Users\foo\bar or D:\something
const WIN_PATH_RE = /[A-Z]:\\[^\s'")\]>}]+/gi;
// Matches Windows forward-slash paths like C:/Users/foo/bar (Node.js sometimes normalizes to this)
const WIN_FWD_PATH_RE = /[A-Z]:\/[^\s'")\]>}]+/gi;
// Matches UNC paths like \\server\share\path
const UNC_PATH_RE = /\\\\[^\s'")\]>}]+/gi;
// Matches Linux/macOS absolute paths like /home/user/something or /opt/pz/server
const UNIX_PATH_RE = /\/(?:home|opt|usr|var|tmp|srv|root|etc|mnt|media)\/[^\s'")\]>}]+/gi;

/**
 * Remove filesystem paths from an error message.
 * @param {string} message - Raw error message
 * @returns {string} Sanitized message safe for client consumption
 */
export function sanitizeError(message) {
  if (!message || typeof message !== 'string') return 'An unexpected error occurred';
  return message
    .replace(WIN_PATH_RE, '[path]')
    .replace(WIN_FWD_PATH_RE, '[path]')
    .replace(UNC_PATH_RE, '[path]')
    .replace(UNIX_PATH_RE, '[path]');
}

/**
 * Apply the same filesystem-path redaction as sanitizeError() to every
 * string value in a structured-error `params` object, so the params
 * channel can't leak a path the plain `error` message text would have
 * redacted (e.g. a `reason` param sourced from raw RCON output). Numbers
 * pass through unchanged; params is only ever string|number by the time
 * it reaches a response (see errorMessage.ts on the client for the
 * matching contract).
 * @param {Record<string, string|number>|undefined} params
 * @returns {Record<string, string|number>|undefined}
 */
export function sanitizeErrorParams(params) {
  if (!params || typeof params !== 'object') return params;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'string' ? sanitizeError(value) : value;
  }
  return out;
}

/**
 * Strip INI-sensitive characters from values to prevent injection.
 * Removes \r, \n (line injection), ; (comment / list delimiter), = (key separator).
 */
export function sanitizeIniValue(value) {
  if (value == null) return '';
  return String(value).replace(/[\r\n;=]/g, '');
}

/**
 * Sanitize an array of values for INI semicolon-delimited fields.
 */
export function sanitizeIniList(values) {
  return values.map(v => sanitizeIniValue(v)).filter(Boolean).join(';');
}

/**
 * Workshop IDs are 5-15 digit numeric strings (Steam fileId). PZ mod IDs
 * (the `id=` field inside mod.info) are letter-based identifiers and must
 * never be all-numeric. We use this to gate Mods= writes so workshop IDs
 * never get accidentally written into the Mods= line.
 */
export function looksLikeWorkshopId(value) {
  return typeof value === 'string' && /^\d{5,15}$/.test(value);
}

/**
 * Sanitize an array of mod IDs for the Mods= INI field. Drops any entry
 * that looks like a Steam Workshop file ID — those belong in
 * WorkshopItems=, never in Mods=, and writing them into Mods= results in
 * a polluted INI that PZ silently ignores.
 *
 * Returns the joined semicolon string. The dropped count is appended on
 * the returned function as a side channel via a wrapper if callers need
 * to log it; for simplicity we just filter here.
 */
export function sanitizeModIdList(values) {
  const out = [];
  for (const raw of values || []) {
    const v = sanitizeIniValue(raw);
    if (!v) continue;
    if (looksLikeWorkshopId(v)) continue; // workshop ID misplaced in Mods=
    out.push(v);
  }
  return out.join(';');
}
