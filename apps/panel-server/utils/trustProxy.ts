const DISABLED_VALUES = new Set(["", "0", "false", "off", "none"]);

export type TrustProxySetting = false | 1 | number | string | string[];

export function parseTrustProxySetting(value: unknown): TrustProxySetting {
  const rawValue = String(value ?? "").trim();
  const normalizedValue = rawValue.toLowerCase();

  if (DISABLED_VALUES.has(normalizedValue)) return false;
  if (normalizedValue === "true") return 1;

  if (/^[+-]?\d+$/.test(rawValue)) {
    const hops = Number(rawValue);
    return Number.isSafeInteger(hops) && hops > 0 ? hops : false;
  }

  const proxyRanges = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return proxyRanges.length === 1 ? proxyRanges[0] : proxyRanges;
}
