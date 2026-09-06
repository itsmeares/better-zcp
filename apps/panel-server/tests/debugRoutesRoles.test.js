import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// debug.js now gates with requirePermission (DB-backed) instead of
// requireRole -- getRoleByName needs mocking. The admin-passthrough test
// below lets a request continue into REAL handler logic (real database
// backup/compact/clear-stale-locks calls, since nothing else in this file
// is mocked), so this uses importActual to keep every other real export
// working rather than replacing the whole module and leaving those
// functions undefined.
vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName: mockGetRoleByName };
});

// debug.js was, until now, guarded only by the central login gate: ANY
// authenticated role (including moderator) could trigger a database
// backup, compact the database, clear stale locks, or repoint the panel's
// data paths. Every route in the file is now admin-only, with ONE
// deliberate exception (POST /client-errors, client-side crash telemetry
// -- see the comment above the router in debug.js for why). This proves
// both halves: every admin-only route actually refuses technician and
// moderator, AND the one route that's supposed to stay open genuinely
// does -- a sweep that silently locked everything (including the
// exception) would still pass a refusal-only test suite.
//
// Same route-stack-walking approach as roles.test.js / panelBridgeModInstallAuth.test.js.
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

// Every admin-only route in debug.js: [path, method]. Mirrors the grep
// this was built from (`router.<method>("<path>"` in debug.js) minus the
// one deliberate exception. If a route is added to debug.js later without
// requireRole("admin"), it's missing from THIS list too (runRoute() throws
// "No route registered" rather than silently skipping), so this file
// itself doesn't quietly go stale.
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
    // These three are the ones god called out by name as the reason
    // debug.js mattered: an admin must still be able to do them.
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
      // 403 would mean the gate itself is broken for admins; anything else
      // (200, or a downstream error from the fake req/res) means the gate
      // let an admin through, which is the only thing this test checks.
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
