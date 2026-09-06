import { describe, expect, it } from "vitest";
import { VALID_ACTIONS, BRIDGE_ACTION_CAPABILITY } from "../routes/panelBridge.js";

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

  it("every key in BRIDGE_ACTION_CAPABILITY is still a real member of VALID_ACTIONS", () => {
    for (const action of Object.keys(BRIDGE_ACTION_CAPABILITY)) {
      expect(VALID_ACTIONS.has(action)).toBe(true);
    }
  });
});
