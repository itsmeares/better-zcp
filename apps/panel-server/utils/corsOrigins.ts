const MAX_CORS_CUSTOM_ORIGINS = 100;
const MAX_CORS_ORIGIN_LENGTH = 256;

export function normalizeOrigin(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  const trimmed = origin.trim();
  if (!trimmed || trimmed.length > MAX_CORS_ORIGIN_LENGTH) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

export function parseOriginList(rawOrigins: unknown): string[] {
  if (typeof rawOrigins !== "string") return [];
  const parsed = rawOrigins
    .split(/[\n,;]+/)
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin));
  return [...new Set(parsed)].slice(0, MAX_CORS_CUSTOM_ORIGINS);
}
