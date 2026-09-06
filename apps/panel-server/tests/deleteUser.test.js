import { beforeEach, describe, expect, it, vi } from "vitest";

// authService.deleteUser -- DELETE /api/auth/users/:id's backend. Same
// in-memory stand-in pattern as changeUserRoleById.test.js (reuses its own
// assertNoRecoveryLockout helper, so these tests are really proving that
// reuse holds for the deletion case too, not re-deriving the lockout rule).
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

describe("authService.deleteUser", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE],
      users: [
        { id: "u-admin", username: "owner", role: "admin", roleId: "role-admin" },
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician" },
      ],
    });
  });

  it("deletes a user with no recovery capabilities cleanly", async () => {
    const result = await authService.deleteUser("u-tech");
    expect(result).toEqual({ id: "u-tech", username: "tech" });
    expect(db.data.users.find((u) => u.id === "u-tech")).toBeUndefined();
    expect(db.data.users).toHaveLength(1);
  });

  it("refuses an unknown userId with a plain 'User not found' error", async () => {
    await expect(authService.deleteUser("no-such-user")).rejects.toThrow(/User not found/);
  });

  it("SELF-DELETE: refused outright, no override, when actingUserId matches the target", async () => {
    await expect(
      authService.deleteUser("u-tech", { actingUserId: "u-tech" }),
    ).rejects.toMatchObject({ code: "USER_SELF_DELETE_REFUSED", status: 400 });
    // Untouched.
    expect(db.data.users.find((u) => u.id === "u-tech")).toBeTruthy();
  });

  it("SELF-DELETE check does not fire for a DIFFERENT acting user", async () => {
    const result = await authService.deleteUser("u-tech", { actingUserId: "u-admin" });
    expect(result.id).toBe("u-tech");
  });

  it("LOCKOUT: refuses to delete the only user with users.manage", async () => {
    await expect(
      authService.deleteUser("u-admin"),
    ).rejects.toMatchObject({
      code: "ROLE_LOCKOUT_LAST_MANAGER",
      status: 409,
      // roles.manage is checked before users.manage (RECOVERY_CAPABILITIES'
      // fixed order) and u-admin is the sole holder of both.
      params: { action: "roles.manage" },
    });
    expect(db.data.users.find((u) => u.id === "u-admin")).toBeTruthy(); // unchanged
  });

  it("LOCKOUT: allows deletion once a second user also holds users.manage", async () => {
    db.data.users.push({
      id: "u-admin-2",
      username: "co-owner",
      role: "admin",
      roleId: "role-admin",
    });

    const result = await authService.deleteUser("u-admin");
    expect(result.id).toBe("u-admin");
    expect(db.data.users.find((u) => u.id === "u-admin")).toBeUndefined();
    expect(db.data.users.find((u) => u.id === "u-admin-2")).toBeTruthy();
  });

  it("LOCKOUT: also protects roles.manage independently of users.manage", async () => {
    const admin = db.data.roles.find((r) => r.id === "role-admin");
    admin.capabilities = ["users.manage"]; // admin no longer the only roles.manage holder's OTHER capability
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
      authService.deleteUser("u-steward"),
    ).rejects.toMatchObject({
      code: "ROLE_LOCKOUT_LAST_MANAGER",
      status: 409,
      params: { action: "roles.manage" },
    });
  });

  it("deletes a user holding a CUSTOM role with no recovery capabilities", async () => {
    db.data.roles.push({
      id: "role-custom-1",
      name: "Event Coordinator",
      capabilities: ["server.control"],
      isSeeded: false,
    });
    db.data.users.push({
      id: "u-custom",
      username: "coordinator",
      role: "Event Coordinator",
      roleId: "role-custom-1",
    });

    const result = await authService.deleteUser("u-custom");
    expect(result.id).toBe("u-custom");
  });
});

describe("authService.deleteUser: sessions stop working immediately, not at token expiry", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE],
      users: [
        { id: "u-admin", username: "owner", role: "admin", roleId: "role-admin" },
        {
          id: "u-tech",
          username: "tech",
          role: "technician",
          roleId: "role-technician",
          tokenGen: 0,
        },
      ],
    });
    authService.jwtSecret = "test-delete-user-secret";
  });

  it("a deleted user's access token stops authenticating on the very next call", async () => {
    const user = db.data.users.find((u) => u.id === "u-tech");
    const accessToken = authService.generateAccessToken(user);

    // Proves the token was genuinely valid before deletion -- otherwise
    // the "fails after" assertion below would be trivially true.
    const before = await authService.authenticateAccessToken(accessToken);
    expect(before?.userId).toBe("u-tech");

    await authService.deleteUser("u-tech");

    const after = await authService.authenticateAccessToken(accessToken);
    expect(after).toBeNull();
  });

  it("a deleted user's refresh token is refused, not silently reissued", async () => {
    const user = db.data.users.find((u) => u.id === "u-tech");
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);

    const before = await authService.refreshAccessToken(refreshToken);
    expect(before?.user?.id).toBe("u-tech");

    await authService.deleteUser("u-tech");

    const after = await authService.refreshAccessToken(refreshToken);
    expect(after).toBeNull();
  });
});
