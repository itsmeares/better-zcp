export function parseBoundedInteger<T>(
  value: unknown,
  fallback: T,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number | T {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[+-]?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

export function parseClampedInteger<T>(
  value: unknown,
  fallback: T,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number | T {
  const parsed = parseBoundedInteger(value, null, min, Number.MAX_SAFE_INTEGER);
  return parsed === null ? fallback : Math.min(parsed, max);
}
