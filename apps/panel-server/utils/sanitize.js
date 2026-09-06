
export const SENSITIVE_FIELD_RE =
  /password|secret|token|apikey|api_key|jwt|sessionid|loginsecure|cookie|webhook/i;

export function isMaskedSecret(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("••••••••")) return true;
  if (/^[•*●○]+$/.test(value)) return true;
  return false;
}

export function maskSecretValue(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return "••••••••" + value.slice(-4);
}

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

export function omitSensitiveFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELD_RE.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function sanitizeServerResponse(server) {
  return maskSensitiveObject(server);
}

export function sanitizeServerResponseList(servers) {
  return Array.isArray(servers) ? servers.map(sanitizeServerResponse) : servers;
}

const WIN_PATH_RE = /[A-Z]:\\[^\s'")\]>}]+/gi;
const WIN_FWD_PATH_RE = /[A-Z]:\/[^\s'")\]>}]+/gi;
const UNC_PATH_RE = /\\\\[^\s'")\]>}]+/gi;
const UNIX_PATH_RE = /\/(?:home|opt|usr|var|tmp|srv|root|etc|mnt|media)\/[^\s'")\]>}]+/gi;

export function sanitizeError(message) {
  if (!message || typeof message !== 'string') return 'An unexpected error occurred';
  return message
    .replace(WIN_PATH_RE, '[path]')
    .replace(WIN_FWD_PATH_RE, '[path]')
    .replace(UNC_PATH_RE, '[path]')
    .replace(UNIX_PATH_RE, '[path]');
}

export function sanitizeErrorParams(params) {
  if (!params || typeof params !== 'object') return params;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'string' ? sanitizeError(value) : value;
  }
  return out;
}

export function sanitizeIniValue(value) {
  if (value == null) return '';
  return String(value).replace(/[\r\n;=]/g, '');
}

export function sanitizeIniList(values) {
  return values.map(v => sanitizeIniValue(v)).filter(Boolean).join(';');
}

export function looksLikeWorkshopId(value) {
  return typeof value === 'string' && /^\d{5,15}$/.test(value);
}

export function sanitizeModIdList(values) {
  const out = [];
  for (const raw of values || []) {
    const v = sanitizeIniValue(raw);
    if (!v) continue;
    if (looksLikeWorkshopId(v)) continue;
    out.push(v);
  }
  return out.join(';');
}
