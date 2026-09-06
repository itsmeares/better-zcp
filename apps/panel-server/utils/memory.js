export function normalizeMemoryGb(value, fallback) {
  const textValue = typeof value === "string" ? value.trim() : null;
  const parsed =
    typeof value === "number"
      ? value
      : textValue && /^\+?\d+$/.test(textValue)
        ? Number(textValue)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  if (parsed > 128) {
    return Math.max(1, Math.round(parsed / 1024));
  }
  return parsed;
}
