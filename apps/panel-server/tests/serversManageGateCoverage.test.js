import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";


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
