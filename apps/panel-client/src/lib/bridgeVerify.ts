// Shared classification for PanelBridge's per-command `verified` field.
// The server returns it inside `data` as the mod's read-back status.
//
// Three states, not a boolean, because "we didn't get a confirmation" has two
// structurally different causes that need different words to the operator:
//   'confirmed'    -- a real read-back was compared against the request and matched.
//   'unverifiable' -- the call succeeded; no read-back exists to compare (a void
//                     game API, or the change too small to distinguish from a
//                     no-op). NOT a failure -- a genuine mismatch is reported as
//                     ok:false with a real error instead, never verified:false.
//   'old-bridge'   -- the `verified` key is missing entirely. The bridge mod runs
//                     on the OPERATOR'S game server and can be older than the
//                     panel (operators update the panel and forget the mod), so a
//                     missing key means the connected mod predates this contract
//                     and never sends the field -- not "unconfirmed", an outright
//                     different, actionable fact (the mod itself is out of date).
export type BridgeVerifiedState = "confirmed" | "unverifiable" | "old-bridge";

// Only actions with a Lua read-back contract belong here. Missing `verified`
// means "old bridge" for these actions; other actions use normal success
// handling because they never promised verification.
export const VERIFY_GATED_ACTIONS: ReadonlySet<string> = new Set([
  "teleportPlayer",
  "setSandboxOption",
  "setGodMode",
  "setInvisible",
  "setNoclip",
  "spawnHordeNearPlayer",
  "spawnHordeBehindPlayer",
  "safehouseAddPlayer",
  "safehouseRemovePlayer",
  "safehouseSetOwner",
  "safehouseSetRespawn",
  "factionAddPlayer",
  "factionRemovePlayer",
  "factionSetTag",
  "vehicleSetAlarm",
  "vehicleSetSiren",
  "vehicleSetTrunkLocked",
  "vehicleSetFuel",
  "vehicleSetBattery",
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
