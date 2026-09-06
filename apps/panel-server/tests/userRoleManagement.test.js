import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_ROLES } from "./helpers/mockPermissionsDb.js";

// Same in-memory stand-in pattern as recoveryCodes.test.js — the real
// service logic (bcrypt, role rules) runs, without touching the panel's
// actual database. changeUserRole() now resolves its target through the
// real roles collection (see its own comment in services/auth.js for why),
// so this needs the same seeded admin/technician/moderator rows every
// other roles-aware test file uses — TEST_ROLES from mockPermissionsDb.js,
// not a fourth copy of the same three arrays.
const settings = new Map();
const db = { data: { users: [], roles: Object.values(TEST_ROLES).map((r) => ({ ...r })) } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id) => db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
}));

const { default: authService, USER_ROLES } = await import(
  "../services/auth.js"
);
const { getOrCreateSetupToken } = await import("../utils/setupToken.js");

describe("USER_ROLES", () => {
  it("is exactly admin, technician, moderator", () => {
    expect(USER_ROLES.sort()).toEqual(
      ["admin", "moderator", "technician"].sort(),
    );
  });
});

describe("createUser — role activation", () => {
  beforeEach(() => {
    settings.clear();
    db.data.users = [];
  });

  it("the first user always becomes admin, even if a different role is requested", async () => {
    const user = await authService.createUser(
      "owner",
      "password123",
      "moderator",
    );
    expect(user.role).toBe("admin");
  });

  it("the first user becomes admin with no role argument at all (the /api/auth/setup call shape)", async () => {
    const user = await authService.createUser("owner", "password123");
    expect(user.role).toBe("admin");
  });

  it("a second user requires an explicit, valid role — no silent default", async () => {
    await authService.createUser("owner", "password123");
    await expect(
      authService.createUser("nobody", "password123"),
    ).rejects.toThrow(/role must be one of/);
  });

  it("a second user is created with the requested role", async () => {
    await authService.createUser("owner", "password123");
    const tech = await authService.createUser(
      "tech1",
      "password123",
      "technician",
    );
    expect(tech.role).toBe("technician");
  });

  it("rejects an unrecognized role", async () => {
    await authService.createUser("owner", "password123");
    await expect(
      authService.createUser("bad", "password123", "superuser"),
    ).rejects.toThrow(/role must be one of/);
  });
});

describe("changeUserRole", () => {
  beforeEach(() => {
    settings.clear();
    db.data.roles = Object.values(TEST_ROLES).map((r) => ({ ...r }));
    db.data.users = [
      { id: "admin-1", username: "owner", role: "admin", password: "x" },
      { id: "tech-1", username: "tech", role: "technician", password: "x" },
    ];
  });

  it("changes a user's role", async () => {
    const result = await authService.changeUserRole("tech-1", "moderator");
    expect(result.role).toBe("moderator");
    expect(db.data.users.find((u) => u.id === "tech-1").role).toBe(
      "moderator",
    );
  });

  it("refuses to demote the only remaining admin -- now via the same capability-aware lockout rule changeUserRoleById uses, not a fixed admin-name count", async () => {
    await expect(
      authService.changeUserRole("admin-1", "technician"),
    ).rejects.toMatchObject({ code: "ROLE_LOCKOUT_LAST_MANAGER" });
    expect(db.data.users.find((u) => u.id === "admin-1").role).toBe("admin");
  });

  it("refuses to demote the last user holding roles.manage/users.manage even when they aren't literally role 'admin' -- the gap this fix closed", async () => {
    // A custom role, not the seeded "admin", holding the same two recovery
    // capabilities. Before the fix, changeUserRole()'s own lockout check
    // only ever looked at the literal string "admin", so moving this user
    // off their custom role sailed through with no check at all.
    db.data.roles.push({
      id: "role-root-ops",
      name: "Root Ops",
      capabilities: ["roles.manage", "users.manage", "server.control"],
      isSeeded: false,
    });
    db.data.users = [
      { id: "alice", username: "alice", role: "Root Ops", roleId: "role-root-ops", password: "x" },
    ];

    await expect(
      authService.changeUserRole("alice", "moderator"),
    ).rejects.toMatchObject({ code: "ROLE_LOCKOUT_LAST_MANAGER" });
    expect(db.data.users[0].role).toBe("Root Ops");
  });

  it("allows demoting an admin when a second admin exists", async () => {
    db.data.users.push({
      id: "admin-2",
      username: "co-owner",
      role: "admin",
      password: "x",
    });
    const result = await authService.changeUserRole("admin-1", "technician");
    expect(result.role).toBe("technician");
  });

  it("rejects an invalid target role", async () => {
    await expect(
      authService.changeUserRole("tech-1", "superuser"),
    ).rejects.toThrow(/role must be one of/);
  });

  it("rejects an unknown user id", async () => {
    await expect(
      authService.changeUserRole("nonexistent", "admin"),
    ).rejects.toThrow(/User not found/);
  });
});

describe("OIDC seam — refuse by default", () => {
  beforeEach(() => {
    settings.clear();
    db.data.users = [
      { id: "admin-1", username: "owner", role: "admin", password: "x" },
    ];
  });

  it("refuses an external identity with no linked local account", async () => {
    const result = await authService.loginWithExternalIdentity({
      issuer: "https://accounts.example.com",
      subject: "ext-sub-1",
    });
    expect(result).toEqual({ linked: false, canBootstrapAdmin: false });
  });

  it("reports canBootstrapAdmin true only when zero local users exist", async () => {
    db.data.users = [];
    const result = await authService.loginWithExternalIdentity({
      issuer: "https://accounts.example.com",
      subject: "ext-sub-1",
    });
    expect(result).toEqual({ linked: false, canBootstrapAdmin: true });
  });

  it("bootstraps the first account as admin from an external identity", async () => {
    db.data.users = [];
    const setupToken = await getOrCreateSetupToken();
    const user = await authService.bootstrapAdminFromExternalIdentity({
      issuer: "https://accounts.example.com",
      subject: "ext-sub-1",
      email: "owner@example.com",
      username: "owner",
      setupToken,
    });
    expect(user.role).toBe("admin");
    expect(db.data.users[0].externalIdentities).toEqual([
      expect.objectContaining({
        issuer: "https://accounts.example.com",
        subject: "ext-sub-1",
      }),
    ]);
    expect(db.data.users[0].password).toBeNull();
  });

  it("refuses to bootstrap once any local user already exists", async () => {
    await expect(
      authService.bootstrapAdminFromExternalIdentity({
        issuer: "https://accounts.example.com",
        subject: "ext-sub-2",
        username: "someone",
      }),
    ).rejects.toThrow(/Setup already completed/);
  });

  it("linking an identity to an existing user makes loginWithExternalIdentity find it", async () => {
    authService.jwtSecret = "test-secret";
    await authService.linkExternalIdentity("admin-1", {
      issuer: "https://accounts.example.com",
      subject: "ext-sub-3",
      email: "owner@example.com",
    });

    const result = await authService.loginWithExternalIdentity({
      issuer: "https://accounts.example.com",
      subject: "ext-sub-3",
    });
    expect(result.linked).toBe(true);
    expect(result.user).toMatchObject({ username: "owner", role: "admin" });
    expect(result.accessToken).toEqual(expect.any(String));
  });

  it("refuses to link an identity already claimed by a different account", async () => {
    db.data.users.push({
      id: "tech-1",
      username: "tech",
      role: "technician",
      password: "x",
    });
    await authService.linkExternalIdentity("admin-1", {
      issuer: "https://accounts.example.com",
      subject: "ext-sub-4",
    });
    await expect(
      authService.linkExternalIdentity("tech-1", {
        issuer: "https://accounts.example.com",
        subject: "ext-sub-4",
      }),
    ).rejects.toThrow(/already linked to a different account/);
  });
});

describe("login() tolerates OIDC-only accounts (no local password)", () => {
  beforeEach(() => {
    settings.clear();
    authService.jwtSecret = "test-secret";
    db.data.users = [
      {
        id: "oidc-1",
        username: "oidconly",
        role: "admin",
        password: null,
        externalIdentities: [
          { issuer: "https://accounts.example.com", subject: "s1" },
        ],
      },
    ];
  });

  it("rejects a password login attempt without throwing", async () => {
    await expect(
      authService.login("oidconly", "anything123"),
    ).rejects.toThrow(/Invalid username or password/);
  });

  it("changePassword gives a clear error instead of crashing on a null hash", async () => {
    await expect(
      authService.changePassword("oidc-1", "anything", "newpassword123"),
    ).rejects.toThrow(/no local password set/);
  });
});
