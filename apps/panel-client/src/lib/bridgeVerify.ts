export type BridgeVerifiedState = "confirmed" | "unverifiable" | "old-bridge";

export const VERIFY_GATED_ACTIONS: ReadonlySet<string> = new Set([
  "teleportPlayer",
  "setSandboxOption",
  "setGodMode",
  "setInvisible",
  "setNoclip",
  "moderationBanUser",
  "moderationBanIP",
  "moderationBanSteamID",
]);

export function getBridgeVerifiedState(
  action: string,
  data: { verified?: unknown } | null | undefined,
): BridgeVerifiedState | null {
  if (!VERIFY_GATED_ACTIONS.has(action)) return null;
  if (data?.verified === "confirmed") return "confirmed";
  if (data?.verified === "unverifiable") return "unverifiable";
  return "old-bridge";
}
