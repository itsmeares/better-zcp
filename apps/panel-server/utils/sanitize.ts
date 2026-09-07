export const SENSITIVE_FIELD_RE =
  /password|secret|token|apikey|api_key|jwt|sessionid|loginsecure|cookie|webhook/i;

export function isMaskedSecret(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("••••••••")) return true;
  return /^[•*●○]+$/.test(value);
}

export function maskSecretValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  return "••••••••" + value.slice(-4);
}

export function maskSensitiveObject(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  const masked: Record<string, unknown> = {
    ...(obj as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(masked)) {
    if (SENSITIVE_FIELD_RE.test(key) && typeof value === "string" && value) {
      masked[key] = maskSecretValue(value);
    }
  }
  return masked;
}

export function omitSensitiveFields(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELD_RE.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function sanitizeServerResponse(server: unknown): unknown {
  return maskSensitiveObject(server);
}

export function sanitizeServerResponseList(servers: unknown): unknown {
  return Array.isArray(servers) ? servers.map(sanitizeServerResponse) : servers;
}

const WIN_PATH_RE = /[A-Z]:\\[^\s'")\]>}]+/gi;
const WIN_FWD_PATH_RE = /[A-Z]:\/[^\s'")\]>}]+/gi;
const UNC_PATH_RE = /\\\\[^\s'")\]>}]+/gi;
const UNIX_PATH_RE = /\/(?:home|opt|usr|var|tmp|srv|root|etc|mnt|media)\/[^\s'")\]>}]+/gi;

export function sanitizeError(message: unknown): string {
  if (!message || typeof message !== "string") {
    return "An unexpected error occurred";
  }
  return message
    .replace(WIN_PATH_RE, "[path]")
    .replace(WIN_FWD_PATH_RE, "[path]")
    .replace(UNC_PATH_RE, "[path]")
    .replace(UNIX_PATH_RE, "[path]");
}

export function sanitizeErrorParams(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === "string" ? sanitizeError(value) : value;
  }
  return out;
}

export function sanitizeIniValue(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/[\r\n;=]/g, "");
}

export function sanitizeIniList(values: unknown[]): string {
  return values.map((value) => sanitizeIniValue(value)).filter(Boolean).join(";");
}

export function looksLikeWorkshopId(value: unknown): boolean {
  return typeof value === "string" && /^\d{5,15}$/.test(value);
}

export function sanitizeModIdList(values: unknown[] | null | undefined): string {
  const out: string[] = [];
  for (const raw of values || []) {
    const value = sanitizeIniValue(raw);
    if (!value) continue;
    if (looksLikeWorkshopId(value)) continue;
    out.push(value);
  }
  return out.join(";");
}
