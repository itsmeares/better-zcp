import { describe, expect, it, vi } from "vitest";


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
    expect(requiredCapabilityForScheduledCommand("bridge:createNoise")).toBe("server.world_events");
  });
});
