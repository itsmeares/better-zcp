export function parseBoundedInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
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

export function parseClampedInteger(
  value,
  fallback,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
) {
  const parsed = parseBoundedInteger(
    value,
    null,
    min,
    Number.MAX_SAFE_INTEGER,
  );
  return parsed === null ? fallback : Math.min(parsed, max);
}
