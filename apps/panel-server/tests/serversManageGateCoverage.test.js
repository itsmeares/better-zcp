import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// bug-hunt-2026-08-27 card if-your-change-is-in-middleware-a-handler-only-
// test-is-blind-to-it: servers.js's POST /, PUT /:id and POST /:id/activate
// are all gated requirePermission("servers.manage") ahead of the real
// handler, but every existing test that exercises these three routes
// (serversRoute.test.js's getCreateHandler/getUpdateHandler,
// createServerFieldParity.test.js, serversRouteEnvFallback.test.js,
// crossProducerShapeGate.test.js's invokeJson) grabs ONLY the LAST handler
// in the route's stack (`layer.route.stack[layer.route.stack.length - 1]`)
// -- structurally skipping the gate middleware ahead of it, same blind spot
// Pam found on POST /panel-bridge/command. serversRoute.test.js even has a
// comment claiming "see roles.test.js for coverage of that gate itself" --
// FALSE: roles.test.js only imports routes/auth.js and routes/docker.js,
// never routes/servers.js at all. So a regression that weakened or removed
// requirePermission("servers.manage") from any of these three routes would
// go completely undetected by the existing suite. DELETE /:id is the one
// sibling mutation route that IS already safely covered (serversRoute.test.js's
// own runRoute() full-stack helper, used at its DELETE /:id describe block)
// -- not duplicated here.
//
// Same shape as chunksRoutesCapability.test.js / permissionsFailClosed.test.js:
// call the gate directly (stack[0], the FIRST handler -- requirePermission
// is always registered first on these routes) and prove both directions, so
// a test that only proved refusal would pass just as well if the capability
// key were typo'd into something not in the catalogue, and a test that only
// proved admission would pass just as well if the gate had been deleted
// from the route entirely.

vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
}));

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
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
  await getGate(router, routePath, method)({ user: { role } }, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

const SERVERS_MANAGE_ROUTES = [
  ["/", "post"],
  ["/:id", "put"],
  ["/:id/activate", "post"],
];

describe("servers.js: POST /, PUT /:id and POST /:id/activate all require servers.manage (route-level gate, not just the last-handler business logic every other test file exercises)", () => {
  it.each(SERVERS_MANAGE_ROUTES)(
    "refuses a moderator (does not hold servers.manage) on %s %s",
    async (routePath, method) => {
      const { default: router } = await import("../routes/servers.js");
      const { res, calledNext } = await runGate(router, routePath, method, "moderator");
      expect(res.getStatusCode()).toBe(403);
      expect(res.getBody()).toEqual({
        error: "Insufficient permissions",
        code: "PERMISSION_DENIED",
      });
      expect(calledNext).toBe(false);
    },
  );

  it.each(SERVERS_MANAGE_ROUTES)(
    "does not refuse a technician (holds servers.manage) on %s %s",
    async (routePath, method) => {
      const { default: router } = await import("../routes/servers.js");
      const { calledNext } = await runGate(router, routePath, method, "technician");
      expect(calledNext).toBe(true);
    },
  );

  it.each(SERVERS_MANAGE_ROUTES)(
    "does not refuse an admin on %s %s",
    async (routePath, method) => {
      const { default: router } = await import("../routes/servers.js");
      const { calledNext } = await runGate(router, routePath, method, "admin");
      expect(calledNext).toBe(true);
    },
  );
});
