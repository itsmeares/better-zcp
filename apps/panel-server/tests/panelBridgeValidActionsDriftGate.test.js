import { describe, expect, it } from "vitest";
import { VALID_ACTIONS, BRIDGE_ACTION_CAPABILITY } from "../routes/panelBridge.js";

// e728248 closed a real bypass: moderationKickUser/BanUser/BanIP/BanSteamID
// were reachable through POST /command with only bridge.command, silently
// granting kick/ban power to any custom role built for GM/world-event
// automation. BRIDGE_ACTION_CAPABILITY is a HARDCODED list of those four
// names. The gap that leaves open: the moment a fifth moderation-tier
// action is added to VALID_ACTIONS, it inherits the exact bypass just
// closed, silently, and nothing here objects -- an instance fix, not a
// gate, same distinction Pam's permissionsDescriptionRegistry.test.js draws
// for capability descriptions.
//
// WHY THIS IS A PIN, NOT A SEMANTIC "LOOKS MODERATION-TIER" DETECTOR:
// the obvious semantic signals were checked and rejected as dishonest --
// they would pass today and silently stop working the day they matter.
//   1. A naming-convention check (action starts with "moderation") is
//      exactly the fragility named in the card: it holds only because
//      today's four all happen to share a prefix. The next one could be
//      named anything -- "kickPlayer", "disciplineUser", whatever the Lua
//      side calls it -- and this test would never see it.
//   2. GET /commands' own documentation array groups actions under comment
//      headers like "=== Moderation Automation ===", which looked like a
//      real, structural signal until actually checked: it is ALREADY
//      missing 26 of VALID_ACTIONS' 100 entries (setNoclip, airdrop, every
//      vehicle/safehouse/faction action, getDebugLog and siblings, etc.) --
//      proof this array drifts from VALID_ACTIONS today, with nothing
//      enforcing the two stay in sync. Founding a security gate on a
//      structure already proven to go stale is worse than no gate: it
//      would look authoritative while quietly missing exactly the case
//      that matters, a new action added to VALID_ACTIONS without ever
//      touching the docs array.
// Neither survives the standard the card set: "a gate that only catches
// the naming convention we happen to use today will pass forever the
// moment it matters." So per the card's own explicit fallback: pin the
// exact current contents of VALID_ACTIONS. Any addition OR removal fails
// this test until a human deliberately reviews it and updates the pin --
// cruder than a semantic detector, but it cannot silently miss a new
// entry, because every new entry is, by construction, a diff against this
// list.
const PINNED_VALID_ACTIONS = [
  "ping",
  "getServerInfo",
  "getWeather",
  "getGameTime",
  "getWorldStats",
  "getPlayerDetails",
  "getAllPlayerDetails",
  "healPlayer",
  "killPlayer",
  "teleportPlayer",
  "setGodMode",
  "setInvisible",
  "setNoclip",
  "giveItem",
  "exportPlayerData",
  "importPlayerData",
  "triggerBlizzard",
  "triggerTropicalStorm",
  "triggerStorm",
  "stopWeather",
  "startRain",
  "stopRain",
  "setSnow",
  "generateWeather",
  "setTemperature",
  "setWind",
  "setFog",
  "setClouds",
  "setDayLight",
  "setNightStrength",
  "setDesaturation",
  "setViewDistance",
  "setAmbient",
  "setClimateFloat",
  "resetClimateOverrides",
  "getClimateFloats",
  "setGameTime",
  "triggerLightning",
  "playWorldSound",
  "playSoundNearPlayer",
  "triggerGunshot",
  "triggerAlarmSound",
  "createNoise",
  "sendToServerChat",
  "sendToAdminChat",
  "sendToGeneralChat",
  "getChatInfo",
  "getUtilitiesStatus",
  "restoreUtilities",
  "shutOffUtilities",
  "saveWorld",
  "getSandboxOptions",
  "getAllSandboxOptions",
  "setSandboxOption",
  "getZombieCount",
  "clearZombiesNearPlayer",
  "clearAllZombies",
  "spawnHordeNearPlayer",
  "spawnHordeBehindPlayer",
  "airdrop",
  "getSafehouses",
  "safehouseAddPlayer",
  "safehouseRemovePlayer",
  "safehouseSetOwner",
  "safehouseSetRespawn",
  "getFactions",
  "createFaction",
  "factionAddPlayer",
  "factionRemovePlayer",
  "factionSetTag",
  "removeFaction",
  "getVehiclesDetailed",
  "vehicleRepair",
  "vehicleSetAlarm",
  "vehicleSetSiren",
  "vehicleSetTrunkLocked",
  "vehicleSetFuel",
  "vehicleSetBattery",
  "removeVehicle",
  "removeVehiclesInArea",
  "spawnVehicleAt",
  "vehicleHotwire",
  "getTimeSpeed",
  "setTimeSpeed",
  "triggerHelicopterEvent",
  "stopHelicopterEvent",
  "triggerSwarmEvent",
  "runEventSequence",
  "getInfrastructureSnapshot",
  "moderationKickUser",
  "moderationBanUser",
  "moderationBanIP",
  "moderationBanSteamID",
  "getDebugLog",
  "setDebugMode",
  "getStats",
  "checkAPI",
  "getAvailableHandlers",
  "clearErrors",
  "getItemCatalog",
  "getVehicleCatalog",
  // Added 2026-08-29 (pin-literal-sendcommand-strings-against-valid-actions):
  // debugItemScript was a real gap, not a false alarm -- POST /catalog/
  // debug-item-script has called sendCommand("debugItemScript", {}) since
  // that route existed, and PanelBridge.lua genuinely implements the
  // handler; it was simply never added here. Reviewed against
  // BRIDGE_ACTION_CAPABILITY per this file's own instruction: given
  // ADDITIONAL semantics (bridge.diagnostics on top of bridge.command, NOT
  // GM_TOOLS_ONLY_ACTIONS replacement semantics) -- a debug probe has no
  // described legitimate-automation-without-bridge.command use case the way
  // the GM four did.
  "debugItemScript",
];

describe("panelBridge.js VALID_ACTIONS drift gate", () => {
  it("VALID_ACTIONS has not changed since this pin was written -- see this file's header comment before touching the pinned list. If VALID_ACTIONS legitimately changed, review every added/removed action against BRIDGE_ACTION_CAPABILITY (does it need players.moderate, or a future addition to that map, on top of bridge.command?) before updating PINNED_VALID_ACTIONS to match", () => {
    const current = [...VALID_ACTIONS].sort();
    const pinned = [...PINNED_VALID_ACTIONS].sort();

    expect(
      current,
      current.length !== pinned.length
        ? `VALID_ACTIONS now has ${current.length} entries, pin expects ${pinned.length}. ` +
            `Added: ${current.filter((a) => !pinned.includes(a)).join(", ") || "(none)"}. ` +
            `Removed: ${pinned.filter((a) => !current.includes(a)).join(", ") || "(none)"}.`
        : "VALID_ACTIONS membership changed without the pin being updated.",
    ).toEqual(pinned);
  });

  // Cheap sibling check: a key in BRIDGE_ACTION_CAPABILITY that is no
  // longer in VALID_ACTIONS at all would mean the mapped action was
  // renamed or removed -- the inline check in POST /command would then
  // never fire for anything, silently, since the action itself can never
  // pass the VALID_ACTIONS.has() check that runs before it.
  it("every key in BRIDGE_ACTION_CAPABILITY is still a real member of VALID_ACTIONS", () => {
    for (const action of Object.keys(BRIDGE_ACTION_CAPABILITY)) {
      expect(VALID_ACTIONS.has(action)).toBe(true);
    }
  });
});
