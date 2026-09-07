import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.ts", () => ({
  getRoleByName: mockGetRoleByName,
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

describe("panelBridge.js: bridge setup/integration control -- admin+technician", () => {
  const ROUTES = [
    ["/auto-configure", "post"],
    ["/scan-server/:serverId", "get"],
    ["/auto-detect", "post"],
    ["/configure", "post"],
    ["/configure-direct", "post"],
    ["/start", "post"],
    ["/stop", "post"],
    ["/scan-paths", "get"],
    ["/refresh", "post"],
    ["/mod-path", "get"],
    ["/world/save", "post"],
  ];

  it.each(ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)("does not refuse a technician at the gate on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: bridge/catalog diagnostics -- admin+technician", () => {
  const ROUTES = [
    ["/debug/log", "get"],
    ["/debug/stats", "get"],
    ["/debug/mode", "post"],
    ["/debug/api", "get"],
    ["/debug/handlers", "get"],
    ["/debug/clear-errors", "post"],
    ["/catalog/scan-items", "post"],
    ["/catalog/scan-vehicles", "post"],
    ["/catalog/debug-item-script", "post"],
  ];

  it.each(ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)("does not refuse a technician at the gate on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: existing SFTP + mod-install gates are unchanged (admin+technician)", () => {
  const ROUTES = [
    ["/sftp/test", "post"],
    ["/sftp/configure", "post"],
    ["/sftp/logs/list", "post"],
    ["/sftp/logs/tail", "post"],
    ["/sftp/config/list", "post"],
    ["/install-local", "post"],
    ["/install-mod-auto", "post"],
    ["/install-mod", "post"],
  ];

  it.each(ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)("does not refuse a technician at the gate on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: POST /command stays admin-only (unchanged, whitelist-free passthrough)", () => {
  it("refuses a technician", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, "/command", "post", "technician");
    expect(res.getStatusCode()).toBe(403);
  });

  it("does not refuse an admin", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, "/command", "post", "admin");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: /status, /ping, /commands stay outside the matrix entirely", () => {
  const TRULY_UNGATED = [
    ["/status", "get"],
    ["/ping", "get"],
    ["/commands", "get"],
  ];

  it.each(TRULY_UNGATED)("%s %s has no requirePermission gate ahead of its handler", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === routePath && entry.route.methods[method],
    );
    expect(layer.route.stack.length).toBe(1);
  });
});

describe("panelBridge.js: GET /server-info -- players.view (previously wide open)", () => {
  it("has a requirePermission gate ahead of its handler", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/server-info" && entry.route.methods.get,
    );
    expect(layer.route.stack.length).toBe(2);
  });

  for (const role of ["admin", "technician", "moderator"]) {
    it(`does not refuse a ${role}`, async () => {
      const { default: router } = await import("../routes/panelBridge.js");
      const { calledNext } = await runGate(router, "/server-info", "get", role);
      expect(calledNext).toBe(true);
    });
  }
});

describe("panelBridge.js: server.world_events (world-wide GM effects, folded in from previously-ungated) -- open to every role", () => {
  const WORLD_EVENTS_ROUTES = [
    ["/weather", "get"],
    ["/weather/blizzard", "post"],
    ["/weather/tropical-storm", "post"],
    ["/weather/storm", "post"],
    ["/weather/stop", "post"],
    ["/weather/generate", "post"],
    ["/weather/snow", "post"],
    ["/weather/rain/start", "post"],
    ["/weather/rain/stop", "post"],
    ["/weather/lightning", "post"],
    ["/climate/floats", "get"],
    ["/climate/float", "post"],
    ["/climate/reset", "post"],
    ["/climate/temperature", "post"],
    ["/climate/wind", "post"],
    ["/climate/fog", "post"],
    ["/climate/clouds", "post"],
    ["/time", "get"],
    ["/time", "post"],
    ["/world/stats", "get"],
    ["/message", "post"],
    ["/sound/world", "post"],
    ["/utilities/status", "get"],
    ["/utilities/restore", "post"],
    ["/utilities/shutoff", "post"],
    ["/zombies/count", "get"],
    ["/zombies/clear-near-player", "post"],
    ["/zombies/clear-all", "post"],
    ["/visual/view-distance", "post"],
    ["/visual/daylight", "post"],
    ["/visual/night-strength", "post"],
    ["/visual/desaturation", "post"],
    ["/visual/ambient", "post"],
    ["/chat/info", "get"],
    ["/chat/alert", "post"],
  ];

  it.each(WORLD_EVENTS_ROUTES)("does not refuse a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "moderator");
    expect(calledNext).toBe(true);
  });

  it.each(WORLD_EVENTS_ROUTES)("does not refuse a technician on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: players.endanger_or_impersonate (targeted zombie/sound actions + chat impersonation) -- admin only, carved out of server.world_events", () => {
  const ENDANGER_ROUTES = [
    ["/sound/near-player", "post"],
    ["/sound/gunshot", "post"],
    ["/sound/alarm", "post"],
    ["/sound/noise", "post"],
    ["/zombies/spawn-near", "post"],
    ["/zombies/spawn-behind", "post"],
    ["/chat/admin", "post"],
    ["/chat/general", "post"],
  ];

  it.each(ENDANGER_ROUTES)("refuses a moderator on %s %s (lost with the split -- intended)", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ENDANGER_ROUTES)("refuses a technician on %s %s (lost with the split -- intended)", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "technician");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ENDANGER_ROUTES)("does not refuse an admin on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "admin");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: players.gm_tools (player-targeted actions + supporting reads, folded in from previously-ungated) -- open to every role", () => {
  const GM_TOOLS_ROUTES = [
    ["/players", "get"],
    ["/players/:username", "get"],
    ["/players/:username/teleport", "post"],
    ["/players/:username/give-item", "post"],
    ["/players/:username/heal", "post"],
    ["/players/:username/kill", "post"],
    ["/players/:username/godmode", "post"],
    ["/players/:username/invisible", "post"],
    ["/sandbox", "get"],
    ["/character/export", "post"],
    ["/character/import", "post"],
    ["/catalog/items", "get"],
    ["/catalog/vehicles", "get"],
  ];

  it.each(GM_TOOLS_ROUTES)("does not refuse a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "moderator");
    expect(calledNext).toBe(true);
  });

  it.each(GM_TOOLS_ROUTES)("does not refuse a technician on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});
