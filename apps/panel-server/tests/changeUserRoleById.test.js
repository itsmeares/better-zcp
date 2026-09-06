import { beforeEach, describe, expect, it, vi } from "vitest";

// Same in-memory stand-in pattern as userRoleManagement.test.js, extended
// with a roles collection: services/permissions.js's getRoles/getRoleById/
// getRoleByName are thin re-exports of the same-named functions from
// database/init.js, so mocking THIS file's roles functions is enough to
// make permissions.js (and, through it, auth.js's new changeUserRoleById)
// see this test's in-memory role data — no need to mock permissions.js
// itself.
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

const { default: authService } = await import("../services/auth.js");

const ADMIN_ROLE = {
  id: "role-admin",
  name: "admin",
  capabilities: ["users.manage", "roles.manage", "server.control"],
  isSeeded: true,
};
const TECHNICIAN_ROLE = {
  id: "role-technician",
  name: "technician",
  capabilities: ["server.control", "backups.manage"],
  isSeeded: true,
};

function resetWith({ roles = [], users = [] }) {
  settings.clear();
  db.data.roles = roles.map((r) => ({ ...r }));
  db.data.users = users.map((u) => ({ ...u }));
}

describe("authService.changeUserRoleById", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE],
      users: [
        { id: "u-admin", username: "owner", role: "admin", roleId: "role-admin" },
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician" },
      ],
    });
  });

  it("reassigns a user to another seeded role, setting both role and roleId", async () => {
    const result = await authService.changeUserRoleById("u-tech", "role-admin");
    expect(result.role).toBe("admin");
    expect(result.roleId).toBe("role-admin");
    const stored = db.data.users.find((u) => u.id === "u-tech");
    expect(stored.role).toBe("admin");
    expect(stored.roleId).toBe("role-admin");
  });

  it("reassigns a user to a CUSTOM role — user.role becomes the custom role's exact name, not a legacy fallback", async () => {
    db.data.roles.push({
      id: "role-custom-1",
      name: "Event Coordinator",
      capabilities: ["server.control"],
      isSeeded: false,
    });

    const result = await authService.changeUserRoleById("u-tech", "role-custom-1");

    expect(result.role).toBe("Event Coordinator");
    expect(result.roleId).toBe("role-custom-1");
  });

  it("refuses an unknown roleId with ROLE_NOT_FOUND / 404 — never falls through to a default role", async () => {
    await expect(
      authService.changeUserRoleById("u-tech", "role-does-not-exist"),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND", status: 404 });
    // Untouched — the refusal happened before any user record was read.
    const stored = db.data.users.find((u) => u.id === "u-tech");
    expect(stored.roleId).toBe("role-technician");
  });

  it("refuses an unknown userId with a plain 'User not found' error", async () => {
    await expect(
      authService.changeUserRoleById("no-such-user", "role-admin"),
    ).rejects.toThrow(/User not found/);
  });

  it("LOCKOUT: refuses to move the only user with users.manage away from it", async () => {
    // u-admin is the only user whose role grants users.manage; moving them
    // to technician (no users.manage) would leave zero users able to
    // manage users at all. u-admin's role also grants roles.manage, and
    // RECOVERY_CAPABILITIES checks roles.manage first, so that's the
    // action the lockout actually reports (u-admin is the sole holder of
    // both, so either check alone would refuse the move).
    await expect(
      authService.changeUserRoleById("u-admin", "role-technician"),
    ).rejects.toMatchObject({
      code: "ROLE_LOCKOUT_LAST_MANAGER",
      status: 409,
      params: { action: "roles.manage" },
    });
    const stored = db.data.users.find((u) => u.id === "u-admin");
    expect(stored.roleId).toBe("role-admin"); // unchanged
  });

  it("LOCKOUT: allows the move once a second user also holds users.manage", async () => {
    db.data.users.push({
      id: "u-admin-2",
      username: "co-owner",
      role: "admin",
      roleId: "role-admin",
    });

    const result = await authService.changeUserRoleById("u-admin", "role-technician");
    expect(result.role).toBe("technician");
  });

  it("LOCKOUT: also protects roles.manage independently of users.manage", async () => {
    // Give u-admin only users.manage (not roles.manage), so Role Steward
    // is genuinely the ONLY holder of roles.manage — isolates this test
    // from the default admin fixture also granting roles.manage.
    const admin = db.data.roles.find((r) => r.id === "role-admin");
    admin.capabilities = ["users.manage"];
    db.data.roles.push({
      id: "role-role-only-manager",
      name: "Role Steward",
      capabilities: ["roles.manage"],
      isSeeded: false,
    });
    db.data.users.push({
      id: "u-steward",
      username: "steward",
      role: "Role Steward",
      roleId: "role-role-only-manager",
    });

    await expect(
      authService.changeUserRoleById("u-steward", "role-technician"),
    ).rejects.toMatchObject({
      code: "ROLE_LOCKOUT_LAST_MANAGER",
      status: 409,
      params: { action: "roles.manage" },
    });
  });

  it("does NOT trip the lockout when the target role still grants every recovery capability the user currently has", async () => {
    // Matches ADMIN_ROLE's full recovery-capability set (users.manage AND
    // roles.manage) so nothing is actually being lost by the move.
    db.data.roles.push({
      id: "role-custom-admin-like",
      name: "Also Manages Everything",
      capabilities: ["users.manage", "roles.manage"],
      isSeeded: false,
    });

    const result = await authService.changeUserRoleById(
      "u-admin",
      "role-custom-admin-like",
    );
    expect(result.role).toBe("Also Manages Everything");
  });
});

describe("authService.changeUserRole (legacy string path) — now delegates to changeUserRoleById, resolved by name", () => {
  // Previously this path carried its own admin-count-only lockout check and
  // needed no roles collection at all. That was the actual bug (see
  // services/auth.js's comment on changeUserRole): it couldn't see a custom
  // role's recovery capabilities, only the literal string "admin". It now
  // resolves the target role by name through the real roles collection and
  // delegates entirely to changeUserRoleById, so it needs the same seeded
  // rows every real install has post-migration (see database/init.js's
  // schema v2) — a bare admin/technician role list is no longer realistic
  // fixture data for this function.
  const MODERATOR_ROLE = {
    id: "role-moderator",
    name: "moderator",
    capabilities: ["players.moderate"],
    isSeeded: true,
  };

  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE, MODERATOR_ROLE],
      users: [
        { id: "u1", username: "owner", role: "admin" },
        { id: "u2", username: "tech", role: "technician" },
      ],
    });
  });

  it("still changes a user's role by name, and now dual-writes roleId too", async () => {
    const result = await authService.changeUserRole("u2", "moderator");
    expect(result.role).toBe("moderator");
    expect(result.roleId).toBe("role-moderator");
  });

  it("still refuses to demote the only remaining admin — now via the capability-aware lockout, same code as changeUserRoleById", async () => {
    await expect(
      authService.changeUserRole("u1", "technician"),
    ).rejects.toMatchObject({ code: "ROLE_LOCKOUT_LAST_MANAGER" });
  });

  it("rejects a target name with no matching role row on this install, instead of silently proceeding with no capabilities", async () => {
    resetWith({
      roles: [TECHNICIAN_ROLE, MODERATOR_ROLE], // no "admin" row this time
      users: [{ id: "u1", username: "owner", role: "technician" }],
    });
    await expect(authService.changeUserRole("u1", "admin")).rejects.toThrow(
      /not configured on this panel/,
    );
  });
});
