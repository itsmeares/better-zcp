import { beforeEach, describe, expect, it, vi } from "vitest";

// The vulnerability this file exists to catch, live-found while testing
// something unrelated: authService.middleware() used to exempt the WHOLE
// /api/auth/* prefix from authentication (a blanket startsWith check), so
// req.user was never set for ANY route under it — including ones gated by
// requireRole/requirePermission, whose own "no req.user -> let it through"
// branch (meant for the auth-disabled case) then admitted every request
// regardless of whether a token was even present. Live-confirmed:
// unauthenticated POST /api/auth/users with role:"admin" created a real
// admin account on a fully set-up install. This file proves the fix in
// both directions — the actually-public paths still work with no token,
// and everything else now genuinely requires one.
const settings = new Map();
const db = { data: { users: [{ id: "u1", username: "admin", role: "admin" }] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
}));

const { default: authService, requireRole } = await import("../services/auth.js");
const { default: authRouter } = await import("../routes/auth.js");

describe("authService.middleware() — /api/auth/* is no longer a blanket exemption", () => {
  let middleware;

  beforeEach(async () => {
    settings.clear();
    db.data.users = [{ id: "u1", username: "admin", role: "admin" }]; // needsSetup() must be false
    await authService.init();
    middleware = authService.middleware();
  });

  async function run(path, { auth = null } = {}) {
    const req = { path, headers: auth ? { authorization: auth } : {} };
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const next = vi.fn();
    await middleware(req, res, next);
    return { req, res, next };
  }

  const PUBLIC_PATHS = [
    "/api/auth/status",
    "/api/auth/setup",
    "/api/auth/login",
    "/api/auth/refresh",
    "/api/auth/logout",
    "/api/auth/reset-status",
    "/api/auth/reset-token/local",
    "/api/auth/reset-password",
    "/api/auth/recovery-status",
    "/api/auth/recover-with-code",
  ];

  it.each(PUBLIC_PATHS)("still lets %s through with NO token — these are meant to be public", async (path) => {
    const { next, res } = await run(path);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(["/api/auth/oidc/status", "/api/auth/oidc/login", "/api/auth/oidc/callback"])(
    "still lets %s through with no token — genuinely pre-session (login screen status check, or the act of becoming authenticated)",
    async (path) => {
      const { next } = await run(path);
      expect(next).toHaveBeenCalledTimes(1);
    },
  );

  // /api/auth/oidc/settings and /api/auth/oidc/test-connection were added
  // later (OIDC settings screen work) and are authenticated + requirePermission
  // -gated -- this used to be a blanket `startsWith("/api/auth/oidc/")`
  // exemption, which would have made both of these permanently unusable
  // (req.user never set under the exemption, so the gate always fails
  // closed) rather than insecure, but was the exact same "route added under
  // an exempted prefix inherits its exemption whether wanted or not" shape
  // as the original incident. Pinned here so nobody "simplifies" the OIDC
  // exemption back into a prefix and reintroduces it.
  it.each(["/api/auth/oidc/settings", "/api/auth/oidc/test-connection"])(
    "%s is NOT exempt — it requires a token like any other authenticated route",
    async (path) => {
      const { next, res } = await run(path);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    },
  );

  const FORMERLY_VULNERABLE_PATHS = [
    "/api/auth/users",
    "/api/auth/me",
    "/api/auth/change-password",
    "/api/auth/recovery-codes",
  ];

  it.each(FORMERLY_VULNERABLE_PATHS)(
    "THE FIX: %s now REFUSES an unauthenticated request instead of silently letting it through",
    async (path) => {
      const { next, res } = await run(path);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    },
  );

  it("the exact live-reproduced case: /api/auth/users with no Authorization header is refused, not admitted", async () => {
    const { next, res } = await run("/api/auth/users");
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });

  it("a formerly-vulnerable path DOES work with a valid token — the fix isn't a new blanket refusal either", async () => {
    authService.jwtSecret = "test-secret-for-this-file";
    const jwt = (await import("jsonwebtoken")).default;
    const token = jwt.sign({ userId: "u1", tokenGen: 0 }, authService.jwtSecret);

    const { req, next, res } = await run("/api/auth/users", {
      auth: `Bearer ${token}`,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    // req.user is set as a side effect for downstream requireRole/
    // requirePermission to read — this is the actual thing that was
    // broken (never set at all under the old blanket exemption).
    expect(req.user).toMatchObject({ username: "admin", role: "admin" });
  });

  it("auth explicitly disabled (authEnabled=false): req.user is set to an explicit synthetic full-access user, not left absent", async () => {
    settings.set("authEnabled", false);
    const { req, next, res } = await run("/api/auth/users"); // no token at all

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({ role: "admin", authDisabled: true });
  });
});

describe("requireRole() — the guard itself fails closed, independent of middleware()", () => {
  function createResponse() {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    return res;
  }

  it("refuses (401) when req.user is missing, rather than the old pass-through — the defense-in-depth half of the fix", () => {
    const gate = requireRole("admin");
    const req = {}; // no req.user at all — the exact shape a future exemption mistake would produce
    const res = createResponse();
    const next = vi.fn();

    gate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });

  it("still checks the role normally when req.user IS present — unaffected by the fail-closed change", () => {
    const gate = requireRole("admin");
    const res = createResponse();
    const next = vi.fn();

    gate({ user: { role: "admin" } }, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const res2 = createResponse();
    gate({ user: { role: "technician" } }, res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(403);
  });
});

describe("/me, /change-password, /recovery-codes — independently safe, pinned so nobody 'simplifies' them onto req.user later", () => {
  // These three call getAuthenticatedUser(req) themselves instead of
  // trusting req.user — proven here by invoking their route handlers
  // DIRECTLY with no req.user set at all (the exact shape they'd see if
  // someone accidentally re-added their path to PUBLIC_AUTH_PATHS above).
  // If a future change ever makes them trust req.user instead, this fails.
  function getLayer(routePath, method) {
    return authRouter.stack.find(
      (entry) => entry.route?.path === routePath && entry.route.methods[method],
    );
  }

  async function runHandlerDirect(routePath, method, req) {
    const layer = getLayer(routePath, method);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    await handler(req, res, () => {});
    return res;
  }

  it("GET /me refuses with no Authorization header even when req.user was never set by middleware", async () => {
    const res = await runHandlerDirect("/me", "get", { headers: {} });
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("POST /change-password refuses with no Authorization header the same way", async () => {
    const res = await runHandlerDirect("/change-password", "post", {
      headers: {},
      body: {},
    });
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("GET /recovery-codes refuses with no Authorization header the same way", async () => {
    const res = await runHandlerDirect("/recovery-codes", "get", { headers: {} });
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
