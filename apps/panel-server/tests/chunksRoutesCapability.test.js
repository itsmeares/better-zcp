import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// chunks.js gates eight routes on chunks.manage -- the three mutating routes
// (/save-path, /delete-chunks, /delete-region) plus, as of the operator
// ruling in hunt-wave12 (2026-08-30), the five reads (/saves,
// /suggested-paths, /chunks/:saveName, /stats/:saveName, /browse) that used
// to sit only behind the global auth middleware, authed but not
// permissioned. chunks.manage is the only chunks capability that exists --
// gating reads behind it couples "can look at saves" to "can delete them,"
// a deliberate, named tradeoff (see the comment above /saves in
// routes/chunks.js), not an oversight. Same shape as
// permissionsFailClosed.test.js: call the gate directly and prove both
// directions. A test that only proved refusal would pass just as well if the
// gate had been left in place but "chunks.manage" typo'd into something not
// in the catalogue (see permissionsFailClosed.test.js's unknown-capability
// case -- that failure mode fails closed too, so it wouldn't even show up
// here as a false green); a test that only proved admission would pass just
// as well if the gate had been deleted from the route entirely.

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
  // requirePermission is always the first handler in chunks.js's per-route stacks.
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

const CHUNKS_MANAGE_ROUTES = [
  ["/save-path", "post"],
  ["/delete-chunks", "post"],
  ["/delete-region", "post"],
  ["/saves", "get"],
  ["/suggested-paths", "get"],
  ["/chunks/:saveName", "get"],
  ["/stats/:saveName", "get"],
  ["/browse", "get"],
];

describe("chunks.js: all eight routes (three mutating, five read) require chunks.manage", () => {
  it.each(CHUNKS_MANAGE_ROUTES)(
    "refuses a moderator (does not hold chunks.manage) on %s %s",
    async (routePath, method) => {
      const { default: router } = await import("../routes/chunks.js");
      const { res, calledNext } = await runGate(router, routePath, method, "moderator");
      expect(res.getStatusCode()).toBe(403);
      expect(res.getBody()).toEqual({
        error: "Insufficient permissions",
        code: "PERMISSION_DENIED",
      });
      expect(calledNext).toBe(false);
    },
  );

  it.each(CHUNKS_MANAGE_ROUTES)(
    "refuses a role that no longer resolves to any row on %s %s (renamed/deleted role -- fails closed, not open)",
    async (routePath, method) => {
      const { default: router } = await import("../routes/chunks.js");
      const { res, calledNext } = await runGate(router, routePath, method, "not-a-real-role");
      expect(res.getStatusCode()).toBe(403);
      expect(calledNext).toBe(false);
    },
  );

  it.each(CHUNKS_MANAGE_ROUTES)(
    "does not refuse a technician (holds chunks.manage) on %s %s -- proves the gate isn't just permanently closed",
    async (routePath, method) => {
      const { default: router } = await import("../routes/chunks.js");
      const { calledNext } = await runGate(router, routePath, method, "technician");
      expect(calledNext).toBe(true);
    },
  );
});
