import { describe, expect, it, vi } from "vitest";


vi.mock("../services/discordBot.ts", () => ({
  normalizeChatRelayScope: vi.fn((value) => value),
}));

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.ts";
vi.mock("../database/init.ts", () => ({
  getRoleByName: mockGetRoleByName,
}));

function createResponse() {
  const response = { status: () => response, json: () => response, set: () => response };
  let statusCode = 200;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = () => response;
  response.set = () => response;
  response.getStatusCode = () => statusCode;
  return response;
}

function fakeRequest(req) {
  return { path: "/", url: "/", method: "GET", ...req };
}
async function runFirstUseLayer(router, req) {
  const res = createResponse();
  const layer = router.stack.find((entry) => !entry.route);
  let calledNext = false;
  await layer.handle(fakeRequest(req), res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

function getRouteLayer(router, routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}
async function runRoute(router, routePath, method, req) {
  const res = createResponse();
  const layer = getRouteLayer(router, routePath, method);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

describe("mods.js: admin+technician (mods/config is technician's job, not moderator's)", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/mods.ts");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/mods.ts");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });

  it("does NOT refuse a moderator on /thumbnail/:id -- the deliberate path-based carve-out overrides the role gate entirely for this one route", async () => {
    const { default: router } = await import("../routes/mods.ts");
    const { calledNext } = await runFirstUseLayer(router, {
      user: { role: "moderator" },
      path: "/thumbnail/123",
    });
    expect(calledNext).toBe(true);
  });
  it("still refuses that same moderator on every other path -- the carve-out is one route, not the whole router", async () => {
    const { default: router } = await import("../routes/mods.ts");
    const { res } = await runFirstUseLayer(router, {
      user: { role: "moderator" },
      path: "/status",
    });
    expect(res.getStatusCode()).toBe(403);
  });
});

describe("discord.js: admin+technician (integration config, not player authority)", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/discord.ts");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/discord.ts");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });
  it("refuses a role that isn't in the allow list at all, not just 'moderator' specifically", async () => {
    const { default: router } = await import("../routes/discord.ts");
    const { res } = await runFirstUseLayer(router, { user: { role: "definitely-not-a-real-role" } });
    expect(res.getStatusCode()).toBe(403);
  });
});

describe("scheduler.ts: admin+technician (task automation operates the server)", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/scheduler.ts");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/scheduler.ts");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });
});

describe("serverFiles.ts: admin+technician (config/backups), ahead of the file's own unconfigured-server gate", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/serverFiles.ts");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/serverFiles.ts");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });
});

describe("serverFinder.js: admin+technician (setup/verification diagnostic)", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/serverFinder.ts");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/serverFinder.ts");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });
});

async function runFirstHandlerOnly(router, routePath, method, req) {
  const res = createResponse();
  const layer = getRouteLayer(router, routePath, method);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  let calledNext = false;
  await layer.route.stack[0].handle(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

describe("players.js: split into players.moderate/gm_tools/view, all still open to admin+technician+moderator", () => {
  const REPRESENTATIVE_ROUTES = [
    ["players.moderate", "/kick", "post"],
    ["players.gm_tools", "/teleport", "post"],
    ["players.view", "/", "get"],
  ];

  for (const [capability, routePath, method] of REPRESENTATIVE_ROUTES) {
    describe(`${capability} (${method.toUpperCase()} ${routePath})`, () => {
      for (const role of ["admin", "technician", "moderator"]) {
        it(`does not refuse a ${role}`, async () => {
          const { default: router } = await import("../routes/players.ts");
          const { calledNext } = await runFirstHandlerOnly(router, routePath, method, {
            user: { role },
          });
          expect(calledNext).toBe(true);
        });
      }
    });
  }
});

describe("rcon.js: mixed -- /execute, connection lifecycle and /history are admin+technician, status/reference stays open to everyone", () => {
  const RESTRICTED = [
    ["/execute", "post"],
    ["/connect", "post"],
    ["/test", "post"],
    ["/disconnect", "post"],
    ["/history", "get"],
  ];
  const OPEN = [
    ["/status", "get"],
    ["/health", "get"],
    ["/commands", "get"],
    ["/commands/:category", "get"],
  ];

  it.each(RESTRICTED)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/rcon.ts");
    const res = await runRoute(router, routePath, method, {
      user: { role: "moderator" },
      body: {},
      params: {},
      query: {},
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(RESTRICTED)("does not refuse a technician at the gate on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/rcon.ts");
    const stubRconService = {
      connect: async () => false,
      disconnect: async () => {},
      execute: async () => ({ success: true, response: "" }),
      getUserFriendlyError: () => "stub error",
    };
    const res = await runRoute(router, routePath, method, {
      user: { role: "technician" },
      body: {},
      params: {},
      query: {},
      app: { get: () => stubRconService },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });

  it.each(OPEN)("stays open to a moderator on %s %s (read-only, nothing sensitive)", async (routePath, method) => {
    const { default: router } = await import("../routes/rcon.ts");
    const stubRconService = {
      getConfig: () => ({ host: "127.0.0.1", port: 27015 }),
      healthCheck: async () => ({ healthy: true }),
    };
    const res = await runRoute(router, routePath, method, {
      user: { role: "moderator" },
      body: {},
      params: {},
      query: {},
      app: { get: () => stubRconService },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });
});

describe("auth.js: recovery codes are admin-only, not delegable to users.manage or any other role", () => {
  const ROUTES = [
    ["/recovery-codes", "get"],
    ["/recovery-codes", "post"],
  ];

  it.each(ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/auth.ts");
    const res = await runRoute(router, routePath, method, {
      user: { role: "moderator" },
      headers: {},
      body: {},
      params: {},
      query: {},
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)(
    "refuses a technician too on %s %s -- users.manage-adjacent is not enough, this is admin-only",
    async (routePath, method) => {
      const { default: router } = await import("../routes/auth.ts");
      const res = await runRoute(router, routePath, method, {
        user: { role: "technician" },
        headers: {},
        body: {},
        params: {},
        query: {},
      });
      expect(res.getStatusCode()).toBe(403);
    },
  );

  it.each(ROUTES)(
    "does not refuse an admin at the role gate on %s %s (a missing Authorization header still 401s downstream -- this only proves the gate itself let an admin through)",
    async (routePath, method) => {
      const { default: router } = await import("../routes/auth.ts");
      const res = await runRoute(router, routePath, method, {
        user: { role: "admin" },
        headers: {},
        body: {},
        params: {},
        query: {},
      });
      expect(res.getStatusCode()).not.toBe(403);
    },
  );
});

describe("mapProxy.ts / serverStatus.js / system.js: deliberately open to every role", () => {
  it("mapProxy /resolve and /vehicles do not refuse a moderator", async () => {
    const { default: router } = await import("../routes/mapProxy.ts");
    for (const [routePath, method] of [
      ["/resolve", "get"],
      ["/vehicles", "get"],
    ]) {
      const res = await runRoute(router, routePath, method, {
        user: { role: "moderator" },
        params: {},
        query: {},
        app: { get: () => undefined },
      });
      expect(res.getStatusCode()).not.toBe(403);
    }
  });

  it("serverStatus GET /active/status does not refuse a moderator", async () => {
    const { default: router } = await import("../routes/serverStatus.ts");
    const res = await runRoute(router, "/active/status", "get", {
      user: { role: "moderator" },
      app: { get: () => undefined },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });

  it("system GET /disk-space and /storage-health do not refuse a moderator", async () => {
    const { default: router } = await import("../routes/system.ts");
    for (const [routePath, method] of [
      ["/disk-space", "get"],
      ["/storage-health", "get"],
    ]) {
      const res = await runRoute(router, routePath, method, {
        user: { role: "moderator" },
        app: { get: () => undefined },
      });
      expect(res.getStatusCode()).not.toBe(403);
    }
  });
});
