import { describe, expect, it, vi } from "vitest";

// requirePermission() must fail closed. Every scenario here is a case
// where a naive implementation could plausibly fall through to next()
// instead of refusing: an unknown capability string, a role row with a
// malformed capabilities array, a user whose role no longer resolves to
// any row at all. None of these are "is the role checked" (a gate test);
// each one asks "does the check inside the gate actually refuse."

const rolesById = new Map();

vi.mock("../database/init.js", () => ({
  getRoles: async () => Array.from(rolesById.values()),
  getRoleById: async (id) => rolesById.get(String(id)) || null,
  getRoleByName: async (name) => Array.from(rolesById.values()).find((r) => r.name === name) || null,
  insertRole: async (role) => {
    rolesById.set(role.id, role);
    return role;
  },
  replaceRoleById: async (id, role) => {
    rolesById.set(String(id), role);
    return role;
  },
  removeRoleById: async (id) => rolesById.delete(String(id)),
  getUsersForRole: async () => [],
  getUsersForRoleAccounting: async () => [],
  reassignRoleMembers: async () => 0,
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

async function runGate(gate, user) {
  const res = createResponse();
  let calledNext = false;
  await gate({ user }, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

describe("requirePermission() fails closed", () => {
  it("refuses when asked for a capability that does not exist in the catalogue -- not a role gate, the check itself", async () => {
    const { requirePermission } = await import("../services/permissions.js");
    rolesById.clear();
    rolesById.set("role-admin", {
      id: "role-admin",
      name: "admin",
      // Deliberately grants EVERYTHING real, to prove this isn't a
      // coincidental refusal from an empty/missing role -- the capability
      // string itself is what's rejected.
      capabilities: ["server.control", "server.wipe", "roles.manage"],
      isSeeded: true,
    });

    const gate = requirePermission("server.does_not_exist");
    const { res, calledNext } = await runGate(gate, { userId: "u1", role: "admin" });

    expect(calledNext).toBe(false);
    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody()).toEqual({
      error: "Insufficient permissions",
      code: "PERMISSION_DENIED",
    });
  });

  it("refuses when the role row's capabilities field is missing", async () => {
    const { requirePermission } = await import("../services/permissions.js");
    rolesById.clear();
    rolesById.set("role-broken", { id: "role-broken", name: "broken", isSeeded: true });

    const gate = requirePermission("server.control");
    const { res, calledNext } = await runGate(gate, { userId: "u1", role: "broken" });

    expect(calledNext).toBe(false);
    expect(res.getStatusCode()).toBe(403);
  });

  it("refuses when the role row's capabilities field is not an array (a string, an object, null)", async () => {
    const { requirePermission } = await import("../services/permissions.js");
    for (const malformed of ["server.control", { "server.control": true }, null, 42]) {
      rolesById.clear();
      rolesById.set("role-broken", {
        id: "role-broken",
        name: "broken",
        capabilities: malformed,
        isSeeded: true,
      });

      const gate = requirePermission("server.control");
      const { res, calledNext } = await runGate(gate, { userId: "u1", role: "broken" });

      expect(calledNext, `malformed capabilities: ${JSON.stringify(malformed)}`).toBe(false);
      expect(res.getStatusCode()).toBe(403);
    }
  });

  it("refuses when the user's role no longer resolves to any row at all (role renamed or deleted out from under an active session)", async () => {
    const { requirePermission } = await import("../services/permissions.js");
    rolesById.clear(); // no roles exist at all -- simulates a deleted role

    const gate = requirePermission("server.control");
    const { res, calledNext } = await runGate(gate, { userId: "u1", role: "moderator" });

    expect(calledNext).toBe(false);
    expect(res.getStatusCode()).toBe(403);
  });

  it("refuses when the role exists but does not grant the requested capability (the ordinary case, still verified end to end)", async () => {
    const { requirePermission } = await import("../services/permissions.js");
    rolesById.clear();
    rolesById.set("role-moderator", {
      id: "role-moderator",
      name: "moderator",
      capabilities: ["players.moderate", "players.gm_tools", "players.view"],
      isSeeded: true,
    });

    const gate = requirePermission("server.wipe");
    const { res, calledNext } = await runGate(gate, { userId: "u1", role: "moderator" });

    expect(calledNext).toBe(false);
    expect(res.getStatusCode()).toBe(403);
  });

  it("POSITIVE CONTROL: does not refuse a real capability a real role genuinely grants -- proves the middleware isn't just permanently closed", async () => {
    const { requirePermission } = await import("../services/permissions.js");
    rolesById.clear();
    rolesById.set("role-technician", {
      id: "role-technician",
      name: "technician",
      capabilities: ["server.control", "server.install"],
      isSeeded: true,
    });

    const gate = requirePermission("server.control");
    const { calledNext } = await runGate(gate, { userId: "u1", role: "technician" });

    expect(calledNext).toBe(true);
  });

  it("refuses (401) when req.user is absent -- this used to pass through and was the exact shape of a real, live, unauthenticated-admin-creation bug (2026-08-22) once authService.middleware() started exempting a whole URL prefix from authentication without also exempting it from this gate. middleware() now always sets an explicit req.user (real or an explicit auth-disabled sentinel), so absence can only ever mean 'not authenticated' here", async () => {
    const { requirePermission } = await import("../services/permissions.js");
    rolesById.clear();

    const gate = requirePermission("server.control");
    const { res, calledNext } = await runGate(gate, undefined);

    expect(calledNext).toBe(false);
    expect(res.getStatusCode()).toBe(401);
    expect(res.getBody()).toEqual({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
  });
});
