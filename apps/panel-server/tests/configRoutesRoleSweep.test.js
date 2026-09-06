import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
}));

// config.js: 15 routes, only PUT /app-settings had a requireRole call.
// PUT / (writes the server's .ini config), PUT /rcon (writes the RCON
// password/host/port) and /cors-debug (diagnostics that can also clear
// blocked-origin state) were reachable by any signed-in account. Same
// both-directions standard as the rest of the sweep.
//
// bug-hunt-2026-08-26: GET/PUT /, POST /reload, GET /options, POST /option,
// GET/PUT /paths and GET/PUT /rcon were removed as dead code (no client
// caller anywhere, undocumented, superseded by serverFilesApi's ini/sandbox
// endpoints and server.js's /configure-rcon) -- see errorCodes.js's removed
// CONFIG_* entries for the sites that used to guard them. The sweep below
// is narrower now because there is genuinely less surface, not because
// coverage was dropped.

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

describe("config.js: server.configure (test-rcon) -- admin+technician", () => {
  const ROUTES = [["/test-rcon", "post"]];

  it.each(ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/config.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)("does not refuse a technician at the gate on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/config.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});

describe("config.js: config.diagnostics (CORS debug snapshot + mutation) -- admin only", () => {
  const ROUTES = [
    ["/cors-debug", "get"],
    ["/cors-debug/reload", "post"],
    ["/cors-debug/blocked", "delete"],
  ];

  it.each(ROUTES)("refuses a technician on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/config.js");
    const { res } = await runGate(router, routePath, method, "technician");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)("does not refuse an admin on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/config.js");
    const { calledNext } = await runGate(router, routePath, method, "admin");
    expect(calledNext).toBe(true);
  });
});

describe("config.js: PUT /app-settings stays admin-only (unchanged, corsAllowAll lives here)", () => {
  it("refuses a technician", async () => {
    const { default: router } = await import("../routes/config.js");
    const { res } = await runGate(router, "/app-settings", "put", "technician");
    expect(res.getStatusCode()).toBe(403);
  });

  it("does not refuse an admin", async () => {
    const { default: router } = await import("../routes/config.js");
    const { calledNext } = await runGate(router, "/app-settings", "put", "admin");
    expect(calledNext).toBe(true);
  });
});

describe("config.js: read-only routes stay open to every role", () => {
  const OPEN = [["/app-settings", "get"]];

  it.each(OPEN)("%s %s has no requireRole gate ahead of its handler", async (routePath, method) => {
    const { default: router } = await import("../routes/config.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === routePath && entry.route.methods[method],
    );
    expect(layer.route.stack.length).toBe(1);
  });
});
