import { beforeEach, describe, expect, it, vi } from "vitest";

// DELETE /api/auth/users/:id -- same mock shape as changeUserRoleRoute.test.js.
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

describe("DELETE /api/auth/users/:id — capability gate", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE],
      users: [
        { id: "u-admin", username: "owner", role: "admin", roleId: "role-admin" },
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician" },
      ],
    });
  });

  it("refuses a technician (no users.manage)", async () => {
    const req = { params: { id: "u-tech" }, user: { role: "technician", userId: "u-tech-caller" } };
    const res = createResponse();
    await runRoute("/users/:id", "delete", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(db.data.users.find((u) => u.id === "u-tech")).toBeTruthy(); // untouched
  });

  it("admits an admin (has users.manage) and actually deletes the target", async () => {
    const req = { params: { id: "u-tech" }, user: { role: "admin", userId: "u-admin" } };
    const res = createResponse();
    await runRoute("/users/:id", "delete", req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        user: expect.objectContaining({ id: "u-tech", username: "tech" }),
      }),
    );
    expect(db.data.users.find((u) => u.id === "u-tech")).toBeUndefined();
  });
});

describe("DELETE /api/auth/users/:id — self-deletion refused via the route", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE],
      users: [
        { id: "u-admin", username: "owner", role: "admin", roleId: "role-admin" },
        { id: "u-admin-2", username: "co-owner", role: "admin", roleId: "role-admin" },
      ],
    });
  });

  it("refuses when the caller (req.user.userId) targets their own account", async () => {
    const req = { params: { id: "u-admin" }, user: { role: "admin", userId: "u-admin" } };
    const res = createResponse();
    await runRoute("/users/:id", "delete", req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "USER_SELF_DELETE_REFUSED" }),
    );
    expect(db.data.users.find((u) => u.id === "u-admin")).toBeTruthy(); // untouched
  });

  it("an admin CAN delete a different admin's account", async () => {
    const req = { params: { id: "u-admin-2" }, user: { role: "admin", userId: "u-admin" } };
    const res = createResponse();
    await runRoute("/users/:id", "delete", req, res);
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(db.data.users.find((u) => u.id === "u-admin-2")).toBeUndefined();
  });
});

describe("DELETE /api/auth/users/:id — lockout surfaces its error code through the route", () => {
  it("the last user able to manage users/roles cannot be deleted, even by someone else", async () => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE],
      users: [
        { id: "u-admin", username: "owner", role: "admin", roleId: "role-admin" },
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician" },
      ],
    });
    // u-tech (technician, no users.manage) can't call this route at all in
    // practice, but the SERVICE-level lockout must hold even if somehow
    // reached -- simulate an admin trying to delete the only OTHER admin
    // by first demoting themselves out of the picture isn't representable
    // here, so this proves the rule via a second caller identity that
    // still passes the gate: u-admin (the sole users.manage holder)
    // targeted by a request that isn't self-deletion.
    const req = { params: { id: "u-admin" }, user: { role: "admin", userId: "some-other-admin-id" } };
    const res = createResponse();
    await runRoute("/users/:id", "delete", req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      // roles.manage is checked before users.manage (RECOVERY_CAPABILITIES'
      // fixed order in services/permissions.js) and u-admin is the sole
      // holder of both, so that's the capability the lockout trips on
      // first. Also proves params reach the wire, not just the code --
      // previously dropped silently by makeRoleError/this route's catch.
      expect.objectContaining({
        code: "ROLE_LOCKOUT_LAST_MANAGER",
        params: { action: "roles.manage" },
      }),
    );
    expect(db.data.users.find((u) => u.id === "u-admin")).toBeTruthy(); // untouched
  });
});
