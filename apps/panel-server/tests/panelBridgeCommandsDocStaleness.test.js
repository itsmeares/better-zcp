import { describe, expect, it } from "vitest";
import { VALID_ACTIONS } from "../routes/panelBridge.js";
import { default as router } from "../routes/panelBridge.js";

// bug-hunt-2026-08-27: GET /panel-bridge/commands is a documentation
// endpoint (its own comment used to claim "complete reference for all 60
// Lua handlers") with NO consumer anywhere in this codebase -- confirmed by
// grepping apps/panel-client/src for every caller of panelBridgeApi.getCommands (zero)
// and a full-history pickaxe on that same client wrapper (zero callers were
// ever added since its introduction in the initial commit). Nothing has
// ever enforced this array staying in sync with VALID_ACTIONS.
//
// Concretely found stale by that lack of enforcement: addLamppost/
// removeLamppost were deliberately dropped from VALID_ACTIONS in release
// v0.8.0 (commit f47ea1a) but stayed listed here, still claiming to be
// callable -- POST /command's own whitelist would refuse either one with
// "Unknown or invalid action" if anyone actually tried them.
//
// This test only enforces the SAFE half of completeness: every action this
// endpoint documents must still be real (a member of VALID_ACTIONS). It
// deliberately does NOT enforce the other half (every VALID_ACTIONS member
// has a doc entry) -- 15 real actions are currently missing from this
// array (setNoclip, getAllSandboxOptions, setSandboxOption, airdrop, four
// vehicle actions, spawnVehicleAt, vehicleHotwire, getTimeSpeed,
// setTimeSpeed, triggerHelicopterEvent, getItemCatalog, getVehicleCatalog),
// and several of those have no dedicated route anywhere in this codebase to
// verify a real argument shape through. Asserting them into existence here
// would document an args shape nobody has confirmed -- the same
// confident-but-wrong failure mode this whole floor has spent the night
// closing, just applied to documentation instead of a security check.
// Reported to god rather than guessed at.
function getCommandsHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/commands" && entry.route.methods.get,
  );
  return layer.route.stack[0].handle;
}

function invokeGetCommands() {
  let body = null;
  const res = { json: (payload) => { body = payload; } };
  getCommandsHandler()({}, res);
  return body;
}

describe("GET /panel-bridge/commands: no stale entries", () => {
  it("every documented action is still a real member of VALID_ACTIONS", () => {
    const { commands } = invokeGetCommands();
    const staleEntries = commands
      .map((c) => c.action)
      .filter((action) => !VALID_ACTIONS.has(action));

    expect(
      staleEntries,
      staleEntries.length
        ? `Documented but no longer in VALID_ACTIONS (would 400 "Unknown or invalid action" if actually called): ${staleEntries.join(", ")}. Remove the stale doc entry, the same way addLamppost/removeLamppost were just removed here.`
        : "",
    ).toEqual([]);
  });
});
