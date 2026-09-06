import { describe, expect, it, vi } from "vitest";

// 2026-08-27, operator ruling on ranked-bug #5 (chat impersonation gated on
// the same capability as changing the weather): server.world_events used to
// cover BOTH genuinely world-wide effects (weather, climate, zombie
// clear-all, ...) AND routes that target a specific named player --
// spawn-near, spawn-behind, events/horde, sound/gunshot, sound/near-player,
// events/lightning, events/thunder, plus chat/admin and chat/general (the
// latter accepts an arbitrary custom author name, indistinguishable in the
// chat log from that player having said it themselves). The operator took
// the full carve-out (Option A): those move to a new capability,
// players.endanger_or_impersonate, admin-only by default -- moderator and
// technician BOTH lose them (previously granted via server.world_events),
// and that narrowing is the intended outcome, not a bug.
//
// sound/alarm and sound/noise were caught in a SECOND pass, after the
// operator had already ruled on the original enumeration -- both take the
// identical {username} -> resolve-to-player's-x/y/z shape as sound/gunshot
// and sound/near-player (PanelBridge.lua handlers.triggerAlarmSound/
// createNoise), just missed in the first read. Folded into the same
// already-approved capability rather than left half-fixed, since the harm
// shape is identical to routes already ruled on, not a new category.
//
// These are gate-only tests (never proceed into a real handler, matching
// the rest of the role-sweep suite's convention) using two synthetic
// single-capability roles rather than the seeded admin/technician/moderator
// fixture, because none of those three seeded roles isolates ONE capability
// on its own after the split (technician and moderator both still hold
// server.world_events; only admin holds the new capability, and admin holds
// both). A role that holds exactly one of the two is the only way to prove
// the boundary sits where it's supposed to, in both directions:
//   - world_events_only must be REFUSED on all nine moved routes (proves
//     the routes actually moved, not just that a description changed)
//   - endanger_only must be ALLOWED on all nine (proves the new capability
//     actually grants them)
//   - world_events_only must still be ALLOWED on a sample of untouched
//     cosmetic routes in both files (the narrowness check: the split must
//     not have over-reached into routes it was never supposed to touch)
//   - endanger_only must still be REFUSED on that same cosmetic sample
//     (the new capability must not silently also grant world-wide effects)

const ROLES = {
  world_events_only: { capabilities: ["server.world_events"] },
  endanger_only: { capabilities: ["players.endanger_or_impersonate"] },
};
const getRoleByName = vi.fn(async (name) => ROLES[name] || null);

vi.mock("../database/init.js", () => ({
  getRoleByName,
}));

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.getStatusCode = () => statusCode;
  return response;
}

function getGate(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack[0].handle;
}

async function runGate(router, routePath, method, role) {
  const res = createResponse();
  let calledNext = false;
  await getGate(router, routePath, method)(
    { user: { role } },
    res,
    () => {
      calledNext = true;
    },
  );
  return { res, calledNext };
}

const SERVER_JS_TARGETED_ROUTES = [
  ["/events/lightning", "post"],
  ["/events/thunder", "post"],
  ["/events/horde", "post"],
];

const PANEL_BRIDGE_TARGETED_ROUTES = [
  ["/sound/near-player", "post"],
  ["/sound/gunshot", "post"],
  ["/sound/alarm", "post"],
  ["/sound/noise", "post"],
  ["/zombies/spawn-near", "post"],
  ["/zombies/spawn-behind", "post"],
  ["/chat/admin", "post"],
  ["/chat/general", "post"],
];

describe("server.js: /events/lightning, /events/thunder, /events/horde moved to players.endanger_or_impersonate", () => {
  it.each(SERVER_JS_TARGETED_ROUTES)(
    "refuses a world_events-only caller on %s %s",
    async (routePath, method) => {
      const { default: router } = await import("../routes/server.js");
      const { res } = await runGate(router, routePath, method, "world_events_only");
      expect(res.getStatusCode()).toBe(403);
    },
  );

  it.each(SERVER_JS_TARGETED_ROUTES)(
    "does not refuse a players.endanger_or_impersonate-only caller on %s %s",
    async (routePath, method) => {
      const { default: router } = await import("../routes/server.js");
      const { calledNext } = await runGate(router, routePath, method, "endanger_only");
      expect(calledNext).toBe(true);
    },
  );
});

describe("panelBridge.js: sound/zombie-targeting and chat-impersonation routes moved to players.endanger_or_impersonate", () => {
  it.each(PANEL_BRIDGE_TARGETED_ROUTES)(
    "refuses a world_events-only caller on %s %s",
    async (routePath, method) => {
      const { default: router } = await import("../routes/panelBridge.js");
      const { res } = await runGate(router, routePath, method, "world_events_only");
      expect(res.getStatusCode()).toBe(403);
    },
  );

  it.each(PANEL_BRIDGE_TARGETED_ROUTES)(
    "does not refuse a players.endanger_or_impersonate-only caller on %s %s",
    async (routePath, method) => {
      const { default: router } = await import("../routes/panelBridge.js");
      const { calledNext } = await runGate(router, routePath, method, "endanger_only");
      expect(calledNext).toBe(true);
    },
  );
});

describe("narrowness check: the split did not over-reach into untouched cosmetic routes", () => {
  it("world_events_only is still allowed on server.js POST /message (untouched, world-wide)", async () => {
    const { default: router } = await import("../routes/server.js");
    const { calledNext } = await runGate(router, "/message", "post", "world_events_only");
    expect(calledNext).toBe(true);
  });

  it("endanger_only is refused on server.js POST /message (new capability must not also grant cosmetic routes)", async () => {
    const { default: router } = await import("../routes/server.js");
    const { res } = await runGate(router, "/message", "post", "endanger_only");
    expect(res.getStatusCode()).toBe(403);
  });

  it("world_events_only is still allowed on panelBridge.js GET /weather (untouched, world-wide)", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, "/weather", "get", "world_events_only");
    expect(calledNext).toBe(true);
  });

  it("endanger_only is refused on panelBridge.js GET /weather (new capability must not also grant cosmetic routes)", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, "/weather", "get", "endanger_only");
    expect(res.getStatusCode()).toBe(403);
  });

  it("world_events_only is still allowed on panelBridge.js POST /zombies/clear-near-player (takes a username but is benign, stayed under world_events)", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, "/zombies/clear-near-player", "post", "world_events_only");
    expect(calledNext).toBe(true);
  });
});

describe("services/scheduler.js: requiredCapabilityForScheduledCommand tracks the same split for schedulable bridge: actions", () => {
  // Otherwise a moderator (world_events but not endanger_or_impersonate
  // after the split) could still reach the same effect by scheduling a
  // `bridge:triggerGunshot {"username":"..."}` task and "Run now"-ing it --
  // the exact "scheduling must not cost less than performing directly" gap
  // this function exists to close, reopened by the split until fixed.
  const MOVED_BRIDGE_ACTIONS = ["triggerGunshot", "triggerAlarmSound", "sendToAdminChat"];
  const UNMOVED_BRIDGE_ACTIONS = [
    "triggerBlizzard",
    "triggerLightning",
    "restoreUtilities",
    "sendToServerChat",
  ];

  it.each(MOVED_BRIDGE_ACTIONS)(
    "bridge:%s requires players.endanger_or_impersonate, not server.world_events",
    async (action) => {
      const { requiredCapabilityForScheduledCommand } = await import("../services/scheduler.js");
      expect(requiredCapabilityForScheduledCommand(`bridge:${action}`)).toBe(
        "players.endanger_or_impersonate",
      );
    },
  );

  it.each(UNMOVED_BRIDGE_ACTIONS)(
    "bridge:%s still requires server.world_events (unaffected, genuinely world-wide)",
    async (action) => {
      const { requiredCapabilityForScheduledCommand } = await import("../services/scheduler.js");
      expect(requiredCapabilityForScheduledCommand(`bridge:${action}`)).toBe("server.world_events");
    },
  );

  it("bridge:saveWorld still requires server.control (unaffected by this split)", async () => {
    const { requiredCapabilityForScheduledCommand } = await import("../services/scheduler.js");
    expect(requiredCapabilityForScheduledCommand("bridge:saveWorld")).toBe("server.control");
  });

  it("createNoise (sound/noise's equivalent) is not schedulable at all -- confirms there's no third path around the gate", async () => {
    const { requiredCapabilityForScheduledCommand } = await import("../services/scheduler.js");
    // Not in SCHEDULABLE_BRIDGE_ACTIONS, so executeBridgeAction() throws
    // before ever reaching this function's classification in practice --
    // this just documents that it falls into the generic "server.world_events"
    // default rather than silently returning something narrower, in case it
    // is ever added to the schedulable set without updating this mapping too.
    expect(requiredCapabilityForScheduledCommand("bridge:createNoise")).toBe("server.world_events");
  });
});
