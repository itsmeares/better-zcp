import { describe, expect, it } from "vitest";
import { VALID_ACTIONS } from "../routes/panelBridge.js";

const PINNED_CLIENT_TEMPLATE_ACTIONS = [
  "getSafehouses",
  "safehouseAddPlayer",
  "safehouseRemovePlayer",
  "safehouseSetOwner",
  "safehouseSetRespawn",
  "getFactions",
  "factionAddPlayer",
  "factionRemovePlayer",
  "factionSetTag",
  "getVehiclesDetailed",
  "triggerSwarmEvent",
  "runEventSequence",
  "getInfrastructureSnapshot",
  "moderationKickUser",
  "moderationBanUser",
  "moderationBanIP",
  "moderationBanSteamID",
];

const PINNED_UNTEMPLATED_ACTIONS = [
  "airdrop",
  "checkAPI",
  "clearAllZombies",
  "clearErrors",
  "clearZombiesNearPlayer",
  "createFaction",
  "createNoise",
  // Added 2026-08-29 (pin-literal-sendcommand-strings-against-valid-actions):
  // debugItemScript is a diagnostics probe reached through its own
  // permission-gated route (POST /catalog/debug-item-script), not something
  // an operator-facing world-event template belongs on -- correctly
  // untemplated, not a gap.
  "debugItemScript",
  "exportPlayerData",
  "generateWeather",
  "getAllPlayerDetails",
  "getAllSandboxOptions",
  "getAvailableHandlers",
  "getChatInfo",
  "getClimateFloats",
  "getDebugLog",
  "getGameTime",
  "getItemCatalog",
  "getPlayerDetails",
  "getSandboxOptions",
  "getServerInfo",
  "getStats",
  "getTimeSpeed",
  "getUtilitiesStatus",
  "getVehicleCatalog",
  "getWeather",
  "getWorldStats",
  "getZombieCount",
  "giveItem",
  "healPlayer",
  "importPlayerData",
  "killPlayer",
  "ping",
  "playSoundNearPlayer",
  "playWorldSound",
  "removeFaction",
  "removeVehicle",
  "removeVehiclesInArea",
  "resetClimateOverrides",
  "restoreUtilities",
  "saveWorld",
  "sendToAdminChat",
  "sendToGeneralChat",
  "sendToServerChat",
  "setAmbient",
  "setClimateFloat",
  "setClouds",
  "setDayLight",
  "setDebugMode",
  "setDesaturation",
  "setFog",
  "setGameTime",
  "setGodMode",
  "setInvisible",
  "setNightStrength",
  "setNoclip",
  "setSandboxOption",
  "setSnow",
  "setTemperature",
  "setTimeSpeed",
  "setViewDistance",
  "setWind",
  "shutOffUtilities",
  "spawnHordeBehindPlayer",
  "spawnHordeNearPlayer",
  "spawnVehicleAt",
  "startRain",
  "stopHelicopterEvent",
  "stopRain",
  "stopWeather",
  "teleportPlayer",
  "triggerAlarmSound",
  "triggerBlizzard",
  "triggerGunshot",
  "triggerHelicopterEvent",
  "triggerLightning",
  "triggerStorm",
  "triggerTropicalStorm",
  "vehicleHotwire",
  "vehicleRepair",
  "vehicleSetAlarm",
  "vehicleSetBattery",
  "vehicleSetFuel",
  "vehicleSetSiren",
  "vehicleSetTrunkLocked",
];

describe("panelBridge action lists: VALID_ACTIONS vs the client's operator-facing templates (Events.tsx)", () => {
  it("every pinned client template action is still a real VALID_ACTIONS member (a stale one would be a dead, always-400ing button)", () => {
    const stale = PINNED_CLIENT_TEMPLATE_ACTIONS.filter((action) => !VALID_ACTIONS.has(action));

    expect(
      stale,
      stale.length
        ? `These bridgeOperationTemplates entries (apps/panel-client/src/pages/Events.tsx) are no longer in VALID_ACTIONS and would 400 "Unknown or invalid action" if invoked: ${stale.join(", ")}`
        : "",
    ).toEqual([]);
  });

  it("the set of VALID_ACTIONS with no client template has not changed since this pin was written -- see this file's header comment before updating it", () => {
    const currentlyUntemplated = [...VALID_ACTIONS]
      .filter((action) => !PINNED_CLIENT_TEMPLATE_ACTIONS.includes(action))
      .sort();
    const pinned = [...PINNED_UNTEMPLATED_ACTIONS].sort();

    expect(
      currentlyUntemplated,
      currentlyUntemplated.length !== pinned.length
        ? `${currentlyUntemplated.length} VALID_ACTIONS members now have no bridgeOperationTemplates entry (pin expects ${pinned.length}). ` +
            `Newly untemplated: ${currentlyUntemplated.filter((a) => !pinned.includes(a)).join(", ") || "(none)"}. ` +
            `Newly templated (remove from PINNED_UNTEMPLATED_ACTIONS, add to PINNED_CLIENT_TEMPLATE_ACTIONS): ${pinned.filter((a) => !currentlyUntemplated.includes(a)).join(", ") || "(none)"}.`
        : "The untemplated-action set changed membership without the pin being updated.",
    ).toEqual(pinned);
  });
});
