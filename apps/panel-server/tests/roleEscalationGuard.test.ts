import { beforeEach, describe, expect, it, vi } from "vitest";

const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.ts", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getDb: vi.fn(async () => db),
  commitNow: vi.fn(async () => {}),
  getRoles: vi.fn(async () => db.data.roles),
  getRoleById: vi.fn(async (id) =>
    db.data.roles.find((role) => String(role.id) === String(id)) || null,
  ),
  getRoleByName: vi.fn(async (name) =>
    db.data.roles.find((role) => role.name === name) || null,
  ),
}));

const { default: authService } = await import("../services/auth.ts");

const ADMIN = {
  id: "role-admin",
  name: "admin",
  capabilities: ["users.manage", "roles.manage", "server.control"],
};
const USER_MANAGER = {
  id: "role-user-manager",
  name: "user-manager",
  capabilities: ["users.manage"],
};
const LIMITED_USER_MANAGER = {
  id: "role-limited-user-manager",
  name: "limited-user-manager",
  capabilities: ["users.manage", "players.view"],
};
const MODERATOR = {
  id: "role-moderator",
  name: "moderator",
  capabilities: ["players.view"],
};

beforeEach(() => {
  db.data.roles = [ADMIN, USER_MANAGER, LIMITED_USER_MANAGER, MODERATOR].map((role) => ({
    ...role,
    capabilities: [...role.capabilities],
  }));
  db.data.users = [
    {
      id: "u-admin",
      username: "admin",
      role: "admin",
      roleId: ADMIN.id,
    },
    {
      id: "u-manager",
      username: "manager",
      role: "user-manager",
      roleId: USER_MANAGER.id,
    },
    {
      id: "u-target",
      username: "target",
      role: "moderator",
      roleId: MODERATOR.id,
    },
    {
      id: "u-limited",
      username: "limited",
      role: "limited-user-manager",
      roleId: LIMITED_USER_MANAGER.id,
    },
  ];
});

describe("role assignment cannot grant capabilities the caller does not hold", () => {
  it("blocks a users.manage-only caller from assigning an admin role", async () => {
    await expect(
      authService.changeUserRoleById("u-target", ADMIN.id, {
        actingUserId: "u-manager",
      }),
    ).rejects.toMatchObject({
      code: "ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES",
      status: 403,
      params: { missing: ["roles.manage", "server.control"] },
    });
    expect(db.data.users.find((user) => user.id === "u-target").roleId).toBe(
      MODERATOR.id,
    );
  });

  it("allows assignment when the target capabilities are a subset of the caller's", async () => {
    const result = await authService.changeUserRoleById(
      "u-target",
      USER_MANAGER.id,
      { actingUserId: "u-manager" },
    );
    expect(result.roleId).toBe(USER_MANAGER.id);
  });

  it("refuses self-role changes even for a fully privileged caller", async () => {
    await expect(
      authService.changeUserRoleById("u-admin", MODERATOR.id, {
        actingUserId: "u-admin",
      }),
    ).rejects.toMatchObject({
      code: "USER_SELF_ROLE_CHANGE_REFUSED",
      status: 400,
    });
  });
});

describe("user creation applies the same capability boundary", () => {
  it("blocks creating an admin from a users.manage-only session", async () => {
    await expect(
      authService.createUser("new-admin", "password123", "admin", {
        actingUserId: "u-manager",
      }),
    ).rejects.toMatchObject({
      code: "ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES",
      status: 403,
    });
    expect(db.data.users.some((user) => user.username === "new-admin")).toBe(false);
  });

  it("allows creating a role whose capabilities the caller already holds", async () => {
    const user = await authService.createUser(
      "new-moderator",
      "password123",
      "moderator",
      { actingUserId: "u-limited" },
    );
    expect(user.role).toBe("moderator");
  });

  it("creates a custom role directly instead of requiring a temporary legacy role", async () => {
    const user = await authService.createUser(
      "new-custom-role-user",
      "password123",
      undefined,
      { actingUserId: "u-limited", roleId: MODERATOR.id },
    );
    expect(user).toMatchObject({ role: MODERATOR.name, roleId: MODERATOR.id });
    expect(db.data.users.find((candidate) => candidate.id === user.id)).toMatchObject({
      role: MODERATOR.name,
      roleId: MODERATOR.id,
    });
  });
});
