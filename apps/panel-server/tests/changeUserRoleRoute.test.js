import { beforeEach, describe, expect, it, vi } from "vitest";

// Same shape as changeUserRoleById.test.js — extends the standard
// database/init.js mock with a roles collection so requirePermission()
// (services/permissions.js) and changeUserRoleById() (services/auth.js)
// both resolve against this test's in-memory roles/users.
const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id) =>
    db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) =>
    db.data.roles.find((r) => r.name === name) || null,
  getUsersForRole: async (role) =>
    db.data.users.filter(
      (u) => u.roleId === role.id || (role.isSeeded && u.role === role.name),
    ),
  insertRole: async (role) => {
    db.data.roles.push(role);
  },
  replaceRoleById: async (id, updated) => {
    const i = db.data.roles.findIndex((r) => String(r.id) === String(id));
    if (i >= 0) db.data.roles[i] = updated;
    return updated;
  },
  removeRoleById: async (id) => {
    db.data.roles = db.data.roles.filter((r) => String(r.id) !== String(id));
    return true;
  },
  getUsersForRoleAccounting: async () =>
    db.data.users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      roleId: u.roleId,
    })),
  reassignRoleMembers: async () => 0,
}));

const { default: authRouter } = await import("../routes/auth.js");

const ADMIN_ROLE = {
  id: "role-admin",
  name: "admin",
  capabilities: ["users.manage", "roles.manage"],
  isSeeded: true,
};
const TECHNICIAN_ROLE = {
  id: "role-technician",
  name: "technician",
  capabilities: ["server.control"],
  isSeeded: true,
};
const MODERATOR_ROLE = {
  id: "role-moderator",
  name: "moderator",
  capabilities: ["players.moderate"],
  isSeeded: true,
};

function resetWith({ roles, users }) {
  settings.clear();
  db.data.roles = roles.map((r) => ({ ...r }));
  db.data.users = users.map((u) => ({ ...u }));
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return authRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(routePath, method, req, res) {
  const layer = getLayer(routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
}

describe("PATCH /api/auth/users/:id/role — capability gate", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE, MODERATOR_ROLE],
      users: [
        { id: "u-admin", username: "owner", role: "admin", roleId: "role-admin" },
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician" },
      ],
    });
  });

  it("refuses a technician (no users.manage) with 403", async () => {
    const req = {
      params: { id: "u-tech" },
      body: { roleId: "role-admin" },
      user: { role: "technician" },
    };
    const res = createResponse();
    await runRoute("/users/:id/role", "patch", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("admits an admin (has users.manage) — the roleId path", async () => {
    const req = {
      params: { id: "u-tech" },
      body: { roleId: "role-admin" },
      user: { role: "admin" },
    };
    const res = createResponse();
    await runRoute("/users/:id/role", "patch", req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        user: expect.objectContaining({ role: "admin", roleId: "role-admin" }),
      }),
    );
  });

  it("legacy role-string path still works, unchanged, through the same route", async () => {
    const req = {
      params: { id: "u-tech" },
      body: { role: "moderator" },
      user: { role: "admin" },
    };
    const res = createResponse();
    await runRoute("/users/:id/role", "patch", req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        user: expect.objectContaining({ role: "moderator" }),
      }),
    );
  });

  it("an unknown roleId is refused with ROLE_NOT_FOUND / 404, not coerced to a default", async () => {
    const req = {
      params: { id: "u-tech" },
      body: { roleId: "role-nonexistent" },
      user: { role: "admin" },
    };
    const res = createResponse();
    await runRoute("/users/:id/role", "patch", req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ROLE_NOT_FOUND" }),
    );
  });

  it("the last user able to manage users cannot be moved away from it — 409 ROLE_LOCKOUT_LAST_MANAGER", async () => {
    const req = {
      params: { id: "u-admin" },
      body: { roleId: "role-technician" },
      user: { role: "admin" },
    };
    const res = createResponse();
    await runRoute("/users/:id/role", "patch", req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ROLE_LOCKOUT_LAST_MANAGER" }),
    );
  });

  it("the lockout response carries params.action on the wire, not just an unparameterized message", async () => {
    // Proves the full round trip: services/auth.js's makeRoleError attaches
    // params, and this route's catch block forwards them (sanitized) in the
    // response body — the exact thing that was silently dropped before.
    const req = {
      params: { id: "u-admin" },
      body: { roleId: "role-technician" },
      user: { role: "admin" },
    };
    const res = createResponse();
    await runRoute("/users/:id/role", "patch", req, res);
    expect(res.json).toHaveBeenCalledWith(
      // roles.manage is checked before users.manage (RECOVERY_CAPABILITIES'
      // fixed order) and u-admin is the sole holder of both, so that's the
      // capability the lockout trips on first.
      expect.objectContaining({
        code: "ROLE_LOCKOUT_LAST_MANAGER",
        params: { action: "roles.manage" },
      }),
    );
  });
});
