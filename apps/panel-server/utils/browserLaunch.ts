const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function shouldAutoOpenBrowser(
  value: unknown = process.env.PANEL_AUTO_OPEN_BROWSER,
): boolean {
  return !DISABLED_VALUES.has(String(value ?? "").trim().toLowerCase());
}
