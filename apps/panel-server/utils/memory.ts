export function normalizeMemoryGb<T>(value: unknown, fallback: T): number | T {
  const textValue = typeof value === "string" ? value.trim() : null;
  const parsed =
    typeof value === "number"
      ? value
      : textValue && /^\+?\d+$/.test(textValue)
        ? Number(textValue)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  if (parsed > 128) return fallback;
  return parsed;
}
