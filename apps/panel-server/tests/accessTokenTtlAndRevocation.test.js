import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

// Auth/sessions security hunt (regression, 2026-08-29). case 1 verdict:
// logout() only ever revokes the refresh SESSION (removes it from
// user.refreshSessions) -- it never touches tokenGen, and
// authenticateAccessToken() (the check that runs on every single
// authenticated request) only ever checks tokenGen. So an already-issued
// access token keeps authenticating for its full remaining life after
// logout, no matter what logout did. That's not a bug in the mechanism --
// it's the real, honest size of a stateless access token's un-revocable
// window, and it used to be 24h because ACCESS_TOKEN_EXPIRY was 24h despite
// this file's own top comment calling that "short-lived."
//
// RULING (testing): shorten ACCESS_TOKEN_EXPIRY to 15m rather than binding
// access tokens to sessions (would require creating a session for every
// login including non-remember-me, plus a session-liveness DB lookup on
// every request -- reintroducing exactly what stateless tokens exist to
// avoid) or bumping tokenGen on logout (MAX_REFRESH_SESSIONS=5 is a
// deliberate multi-device feature; that would kill every OTHER device too).
// 15m is anchored to two real, measured properties, not a round number:
// apps/panel-client/src/lib/api.ts already does deduped transparent refresh-on-401
// (the machinery that makes a short TTL free already exists), and the
// client's busiest legitimate polling interval found in this codebase is
// 5s (ServerConfig.tsx) -- 15m sits two orders of magnitude above every
// observed polling interval, so active use never re-triggers more than one
// refresh per TTL window.
//
// This file proves, server-side, every property that ruling depends on:
//   1. The TTL really is 15m now (not silently still 24h somewhere).
//   2. Expiry is genuinely enforced -- a token past its exp is rejected,
//      not just a token that "looks old."
//   3. The residual window is real and bounded, not zero and not
//      unbounded: a token issued before logout (session revoked) keeps
//      authenticating -- that's the accepted, now-quantified 15m residual,
//      not a regression to test away.
//   4. The SERVER half of the contract apps/panel-client/src/lib/api.ts's transparent
//      refresh depends on actually holds: an expired access token fails
//      authentication, refreshAccessToken() with the (still-valid, 30d)
//      refresh token issues a working NEW access token, with nothing else
//      required -- proving a session really can survive a token expiry
//      without the user re-entering credentials. (The client-side half --
//      that api.ts actually calls this in response to a 401 -- was read
//      directly, not re-tested here: client/ is the file this wave,
//      and the client mechanism itself is unchanged by this server-side
//      TTL edit.)
//   5. Role changes and account deletion ALREADY take effect on the very
//      next request, never gated behind token expiry -- both
//      authenticateAccessToken() and refreshAccessToken() re-read the
//      user's role/existence from the live database on every call, never
//      from the token payload. Deletion already has its own dedicated
//      test (deleteUser.test.js); this file adds the role-change case
//      the test required to have stated rather than assumed.

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

const { default: authService, ACCESS_TOKEN_EXPIRY } = await import("../services/auth.js");

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
    // Hand-construct rather than generateAccessToken() + a wait: same
    // payload shape, but with exp already in the past -- exercises the
    // exact boundary condition, not "a token that happens to be a bit old."
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

    // The refresh session is really gone -- logout did something real.
    const refreshAfterLogout = await authService.refreshAccessToken(refreshToken);
    expect(refreshAfterLogout).toBeNull();

    // But the access token issued earlier still works -- this is the
    // documented residual, now bounded to 15m instead of 24h.
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

    // Step 1: exactly what middleware() sees on the client's original
    // request -- rejected, matches the TOKEN_EXPIRED code path.
    expect(await authService.authenticateAccessToken(expiredAccessToken)).toBeNull();

    // Step 2: exactly what POST /api/auth/refresh does with the refresh
    // cookie the client automatically sends alongside that failed request.
    const refreshResult = await authService.refreshAccessToken(refreshToken);
    expect(refreshResult).not.toBeNull();
    expect(refreshResult.accessToken).toBeTruthy();
    expect(refreshResult.accessToken).not.toBe(expiredAccessToken);

    // Step 3: exactly what the client's automatic retry (fetchWithRetry in
    // api.ts, using the new token from step 2) needs to succeed for the
    // user to never notice the expiry happened.
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
    const accessToken = authService.generateAccessToken(user); // issued while role="technician"

    const before = await authService.authenticateAccessToken(accessToken);
    expect(before.role).toBe("technician");

    await authService.changeUserRoleById("u-tech", "role-admin");

    // Same, unchanged, already-issued token -- authenticateAccessToken()
    // re-reads the LIVE user record every call, never trusts the role
    // embedded in the token payload at issue time.
    const after = await authService.authenticateAccessToken(accessToken);
    expect(after.role).toBe("admin");
  });

  // Deletion's immediate-effect property already has its own dedicated
  // coverage in deleteUser.test.js ("sessions stop working immediately,
  // not at token expiry") -- not duplicated here.
});
