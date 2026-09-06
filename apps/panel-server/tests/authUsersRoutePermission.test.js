import { beforeEach, describe, expect, it, vi } from "vitest";

// GET/POST /api/auth/users used to be requireRole("admin") — a literal
// role-name check — while PATCH /api/auth/users/:id/role beside them was
// already on requirePermission("users.manage"). That split meant an
// operator could grant a custom role users.manage (the matrix would show
// it granted, the server would store it) and that role could still not
// list users or populate a role picker, because these two routes checked
// a name instead of the capability. This file proves a genuine CUSTOM role
// (neither "admin" nor a seeded name) is admitted purely on holding the
// capability, and refused purely on not holding it — not on its name.
// Same mock shape as changeUserRoleRoute.test.js, kept self-contained per
// file to avoid a circular-mock deadlock with services/permissions.js.
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

// Deliberately NOT named "admin" or any legacy role string — proves the
// gate is reading the capability, not recognizing a familiar name.
const RECEPTIONIST_ROLE = {
  id: "role-receptionist",
  name: "front-desk",
  capabilities: ["users.manage"],
  isSeeded: false,
};
const BYSTANDER_ROLE = {
  id: "role-bystander",
  name: "bystander",
  capabilities: ["server.control"],
  isSeeded: false,
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

describe("GET/POST /api/auth/users — capability gate, not a hardcoded role name", () => {
  beforeEach(() => {
    resetWith({
      roles: [RECEPTIONIST_ROLE, BYSTANDER_ROLE],
      users: [
        {
          id: "u1",
          username: "clara",
          role: "front-desk",
          roleId: "role-receptionist",
        },
      ],
    });
  });

  it("GET /users: a custom role holding users.manage is admitted", async () => {
    const req = { user: { role: "front-desk" } };
    const res = createResponse();
    await runRoute("/users", "get", req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        users: expect.arrayContaining([
          expect.objectContaining({ username: "clara" }),
        ]),
      }),
    );
  });

  it("GET /users: a custom role WITHOUT users.manage is refused", async () => {
    const req = { user: { role: "bystander" } };
    const res = createResponse();
    await runRoute("/users", "get", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("POST /users: a custom role holding users.manage is admitted and can create an account", async () => {
    const req = {
      body: { username: "newhire", password: "password123", role: "moderator" },
      user: { role: "front-desk" },
    };
    const res = createResponse();
    await runRoute("/users", "post", req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(db.data.users.some((u) => u.username === "newhire")).toBe(true);
  });

  it("POST /users: a custom role WITHOUT users.manage is refused before any account is created", async () => {
    const req = {
      body: { username: "newhire", password: "password123", role: "moderator" },
      user: { role: "bystander" },
    };
    const res = createResponse();
    await runRoute("/users", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(db.data.users.some((u) => u.username === "newhire")).toBe(false);
  });

  it("GET /users: no req.user at all is refused (401), not treated as a permission decision", async () => {
    const req = {};
    const res = createResponse();
    await runRoute("/users", "get", req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
