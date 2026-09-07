import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.ts", async () => {
  const actual = await vi.importActual("../database/init.ts");
  return { ...actual, getRoleByName: mockGetRoleByName };
});

const { default: debugRouter } = await import("../routes/debug.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = () => response;
  response.getStatusCode = () => statusCode;
  return response;
}

function getLayer(router, routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(router, routePath, method, req) {
  const res = createResponse();
  const layer = getLayer(router, routePath, method);
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

const ADMIN_ONLY_ROUTES = [
  ["/ram", "get"],
  ["/system", "get"],
  ["/logs", "get"],
  ["/logs/files", "get"],
  ["/logs/download", "get"],
  ["/logs/download-zip", "get"],
  ["/logs/download/:filename", "get"],
  ["/logs/clear", "post"],
  ["/paths", "post"],
  ["/health", "get"],
  ["/diagnostics", "get"],
  ["/worldmap", "get"],
  ["/performance-history", "get"],
  ["/performance-snapshot", "post"],
  ["/database", "get"],
  ["/database/backup", "post"],
  ["/database/compact", "post"],
  ["/clear-stale-locks", "post"],
  ["/crash-logs", "get"],
  ["/crash-logs/:filename", "get"],
  ["/activity", "get"],
];

describe("debug.js: every route is admin-only except the one documented exception", () => {
  it.each(ADMIN_ONLY_ROUTES)("refuses a technician on %s %s", async (routePath, method) => {
    const res = await runRoute(debugRouter, routePath, method, {
      user: { role: "technician" },
      params: {},
      query: {},
      body: {},
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ADMIN_ONLY_ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const res = await runRoute(debugRouter, routePath, method, {
      user: { role: "moderator" },
      params: {},
      query: {},
      body: {},
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it("does not refuse an admin at the role gate for the routes named explicitly as the risk (may still do real work downstream)", async () => {
    for (const [routePath, method] of [
      ["/database/backup", "post"],
      ["/database/compact", "post"],
      ["/clear-stale-locks", "post"],
    ]) {
      const res = await runRoute(debugRouter, routePath, method, {
        user: { role: "admin" },
        params: {},
        query: {},
        body: {},
      });
      expect(res.getStatusCode()).not.toBe(403);
    }
  });

  it("POST /client-errors stays open to a technician (the deliberate exception)", async () => {
    const res = await runRoute(debugRouter, "/client-errors", "post", {
      user: { role: "technician" },
      ip: "127.0.0.1",
      body: { message: "test client error" },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });

  it("POST /client-errors stays open to a moderator (the deliberate exception)", async () => {
    const res = await runRoute(debugRouter, "/client-errors", "post", {
      user: { role: "moderator" },
      ip: "127.0.0.1",
      body: { message: "test client error" },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });

  it("POST /client-errors also works with no role at all (matches its pre-existing behavior)", async () => {
    const res = await runRoute(debugRouter, "/client-errors", "post", {
      ip: "127.0.0.1",
      body: { message: "test client error" },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });
});
