import { describe, expect, it } from "vitest";
import { VALID_ACTIONS } from "../routes/panelBridge.js";

// regression, merge of three-unsynced-lists-of-the-same-
// bridge-actions + three-bridge-action-lists-at-three-different-sizes
// (testing, ranked #11/#12): the same set of bridge actions is written down
// in THREE places and nothing keeps any two in sync -- VALID_ACTIONS (100
// entries, the enforcement surface, pinned by
// panelBridgeValidActionsDriftGate.test.js), the GET /commands doc array
// (85 entries, partially gated by panelBridgeCommandsDocStaleness.test.js
// -- that gate only enforces "no stale entry," not "no missing entry",
// for reasons its own header explains), and bridgeOperationTemplates in
// apps/panel-client/src/pages/Events.tsx (17 entries -- THE ONLY ONE AN OPERATOR
// EVER READS for this generic "advanced bridge operation" form).
//
// the description audit (Events.bridgeOperationDescriptionAudit
// .test.ts) checks whether EXISTING template entries lie about what they
// do -- by construction it cannot see the question this test answers:
// which enforceable actions have NO template at all, so an operator can
// never reach them through this form regardless of whether its
// description would have been honest.
//
// FULL DERIVATION WAS REJECTED for the same reason the contract rejects it for
// the doc array's missing-entry direction: most of the 83 actions with no
// client template already have dedicated, purpose-built UI elsewhere
// (weather triggers via Scheduler.tsx's command presets, kick/ban via
// Players.tsx, read-only telemetry actions with no form at all because
// nothing needs to POST them). bridgeOperationTemplates is a deliberately
// curated subset for safehouse/faction/vehicle-detail/moderation/event-
// sequence operations that don't have a home elsewhere -- it was never
// meant to mirror all 100 actions, and auto-generating generic entries
// for the other 83 would document a form nobody designed, the same
// confident-but-wrong shape this whole floor has spent tonight closing.
//
// So: a gate, not derivation, mirroring PINNED_VALID_ACTIONS' own
// fallback exactly -- pin the client's small, stable list (eyeball it
// against Events.tsx's getBridgeOperationTemplates keys when this fails,
// not imported directly: cross-importing a client .tsx into a server
// vitest config, or the reverse, pulls in a rendering/i18n or an
// Express+DB stack neither side's test environment is set up for), then
// diff it against the LIVE VALID_ACTIONS import. Any VALID_ACTIONS
// addition or removal changes the computed gap and fails this test,
// forcing a human to decide per action: does it need an operator-facing
// template, or does it already have a home elsewhere? That decision is
// deliberately not automated, same as PINNED_VALID_ACTIONS itself.
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

// Snapshot of VALID_ACTIONS minus PINNED_CLIENT_TEMPLATE_ACTIONS at the
// time this gate was written. A currently-untemplated action gaining a
// template shrinks this list (good -- update the pin to match). A new
// VALID_ACTIONS member with no template grows it (needs a decision, not a
// silent gap). Either way, the fix is deciding, then updating this pin.
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
