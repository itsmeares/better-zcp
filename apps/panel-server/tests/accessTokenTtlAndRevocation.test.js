import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";


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
}));

const { default: authService, ACCESS_TOKEN_EXPIRY } = await import("../services/auth.ts");

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

describe("ACCESS_TOKEN_EXPIRY: really 15m now, not silently still 24h", () => {
  it("is the exact string '15m'", () => {
    expect(ACCESS_TOKEN_EXPIRY).toBe("15m");
  });

  it("a real generated token's exp is genuinely ~15 minutes out, not 24 hours", () => {
    authService.jwtSecret = "test-ttl-secret";
    const user = { id: "u1", username: "someone", role: "technician", tokenGen: 0 };
    const token = authService.generateAccessToken(user);
    const decoded = jwt.decode(token);

    const lifetimeSeconds = decoded.exp - decoded.iat;
    expect(lifetimeSeconds).toBe(15 * 60);
  });
});

describe("Expiry is genuinely enforced, not merely labeled", () => {
  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [{ id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 }],
    });
    authService.jwtSecret = "test-ttl-secret";
  });

  it("a token whose exp has already passed is rejected, even though every other claim is valid", async () => {
    const user = db.data.users[0];
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, tokenGen: user.tokenGen, exp: nowSeconds - 60 },
      authService.jwtSecret,
    );

    const result = await authService.authenticateAccessToken(expiredToken);

    expect(result).toBeNull();
  });

  it("positive control: the identical payload with exp one minute in the FUTURE still authenticates -- proves the rejection above is really about time, not a malformed test token", async () => {
    const user = db.data.users[0];
    const nowSeconds = Math.floor(Date.now() / 1000);
    const stillValidToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, tokenGen: user.tokenGen, exp: nowSeconds + 60 },
      authService.jwtSecret,
    );

    const result = await authService.authenticateAccessToken(stillValidToken);

    expect(result?.userId).toBe("u-tech");
  });
});

describe("JWT verification accepts only the configured signing algorithm", () => {
  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [{ id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 }],
    });
    authService.jwtSecret = "test-ttl-secret";
  });

  it("rejects HS384 tokens across access-token and refresh-token paths", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const payload = { userId: user.id, username: user.username, role: user.role, tokenGen: user.tokenGen };
    const accessToken = jwt.sign(payload, authService.jwtSecret, { algorithm: "HS384" });
    const refreshToken = jwt.sign(
      { userId: user.id, type: "refresh", tokenGen: user.tokenGen, sessionId: session.id },
      authService.jwtSecret,
      { algorithm: "HS384" },
    );

    await expect(authService.authenticateAccessToken(accessToken)).resolves.toBeNull();
    expect(authService.verifyAccessToken(accessToken)).toBeNull();
    await expect(authService.refreshAccessToken(refreshToken)).resolves.toBeNull();
    await expect(authService.logout(refreshToken)).resolves.toBe(false);
  });
});

describe("The residual window is real and bounded (15m), not zero and not unbounded", () => {
  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [{ id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 }],
    });
    authService.jwtSecret = "test-ttl-secret";
  });

  it("an access token issued before logout keeps authenticating after logout -- the accepted residual, not a regression", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);
    const accessToken = authService.generateAccessToken(user);

    const loggedOut = await authService.logout(refreshToken);
    expect(loggedOut).toBe(true);

    const refreshAfterLogout = await authService.refreshAccessToken(refreshToken);
    expect(refreshAfterLogout).toBeNull();

    const stillAuthenticates = await authService.authenticateAccessToken(accessToken);
    expect(stillAuthenticates?.userId).toBe("u-tech");
  });
});

describe("The server-side refresh contract apps/panel-client/src/lib/api.ts's transparent 401-retry depends on", () => {
  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [{ id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 }],
    });
    authService.jwtSecret = "test-ttl-secret";
  });

  it("an expired access token fails, refreshAccessToken() with the still-valid refresh token issues a fresh one, and the fresh one authenticates -- a session can survive a token expiry with no re-login", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredAccessToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, tokenGen: user.tokenGen, exp: nowSeconds - 1 },
      authService.jwtSecret,
    );

    expect(await authService.authenticateAccessToken(expiredAccessToken)).toBeNull();

    const refreshResult = await authService.refreshAccessToken(refreshToken);
    expect(refreshResult).not.toBeNull();
    expect(refreshResult.accessToken).toBeTruthy();
    expect(refreshResult.accessToken).not.toBe(expiredAccessToken);

    const authAfterRefresh = await authService.authenticateAccessToken(refreshResult.accessToken);
    expect(authAfterRefresh?.userId).toBe("u-tech");
  });
});

describe("Admin-initiated revocation already takes effect immediately, not at token expiry -- stated explicitly per the follow-up question", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE],
      users: [{ id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 }],
    });
    authService.jwtSecret = "test-ttl-secret";
  });

  it("a demoted/promoted user's ALREADY-ISSUED access token reflects the NEW role on its very next use -- no re-login, no waiting for the old token to expire", async () => {
    const user = db.data.users[0];
    const accessToken = authService.generateAccessToken(user);

    const before = await authService.authenticateAccessToken(accessToken);
    expect(before.role).toBe("technician");

    await authService.changeUserRoleById("u-tech", "role-admin");

    const after = await authService.authenticateAccessToken(accessToken);
    expect(after.role).toBe("admin");
  });

  // Deletion's immediate-effect property already has its own dedicated
  // coverage in deleteUser.test.js ("sessions stop working immediately,
  // not at token expiry") -- not duplicated here.
});
