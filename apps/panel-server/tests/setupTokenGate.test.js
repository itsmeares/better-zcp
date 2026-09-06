import { beforeEach, describe, expect, it, vi } from "vitest";

// Same in-memory stand-in pattern as userRoleManagement.test.js — real
// service logic runs (bcrypt, JWT, the setup-token gate itself) against a
// plain object instead of the panel's actual database. setupToken.js reads
// and writes through this same mock, so getOrCreateSetupToken()/
// verifySetupToken()/clearSetupToken() all observe the same state the
// route handlers and authService see.
const settings = new Map();
const db = { data: { users: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
}));

// Rate limiting itself isn't what this file tests, and express-rate-limit's
// real middleware expects a fuller request/response shape (req.socket,
// standard header methods, etc.) than these route-level tests construct.
// Replaced with a pass-through so setupLimiter never gets in the way of
// exercising the actual setup-token gate below it in the stack.
vi.mock("express-rate-limit", () => ({
  default: () => (_req, _res, next) => next(),
}));

const { default: authService } = await import("../services/auth.js");
const { getOrCreateSetupToken } = await import("../utils/setupToken.js");
const { default: authRouter } = await import("../routes/auth.js");

function createResponse() {
  // /setup runs behind setupLimiter (express-rate-limit), which needs a
  // fuller response shape than the route handler itself does.
  const response = {
    status: vi.fn(),
    json: vi.fn(),
    cookie: vi.fn(),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    removeHeader: vi.fn(),
    end: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.cookie.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return authRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

// Runs a route through its FULL declared middleware stack (e.g. setupLimiter
// ahead of the /setup handler itself), the same shape a real request takes.
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

function makeReq(body, ip) {
  return { body, ip, headers: {} };
}

describe("authService.middleware() — the pre-setup gate", () => {
  let middleware;

  beforeEach(() => {
    settings.clear();
    db.data.users = [];
    middleware = authService.middleware();
  });

  async function run(path, { needsUser = false } = {}) {
    if (needsUser) db.data.users = [{ id: "u1", role: "admin" }];
    const req = { path, headers: {} };
    const res = createResponse();
    const next = vi.fn();
    await middleware(req, res, next);
    return { req, res, next };
  }

  it("lets non-/api paths through unconditionally", async () => {
    const { next, res } = await run("/index.html");
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("lets /api/auth/* through even with zero users (the setup wizard's own traffic)", async () => {
    const { next } = await run("/api/auth/setup");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("lets /api/health through unconditionally", async () => {
    const { next } = await run("/api/health");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("lets /api/debug/client-errors through with zero users (crash reporting must work pre-login)", async () => {
    const { next } = await run("/api/debug/client-errors");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("REFUSES an unrelated route with zero users instead of the old blanket bypass -- this is the actual fix", async () => {
    const { next, res } = await run("/api/debug/system");
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SETUP_REQUIRED" }),
    );
  });

  it("still refuses an unrelated route with zero users even for a path that looks like a debug subpath", async () => {
    const { next, res } = await run("/api/players");
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("once a user exists, an unauthenticated request to a normal route still gets the ordinary AUTH_REQUIRED 401 -- unaffected by this change", async () => {
    const { next, res } = await run("/api/players", { needsUser: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });
});

describe("POST /api/auth/setup — the setup-token gate", () => {
  beforeEach(async () => {
    settings.clear();
    db.data.users = [];
    // The real app calls this once at startup; the /setup route's
    // auto-login step needs a jwtSecret to sign tokens with.
    await authService.init();
  });

  it("refuses a missing token before touching anything else", async () => {
    const req = makeReq(
      { username: "op", password: "correct horse battery" },
      "10.0.0.1",
    );
    const res = createResponse();
    await runRoute("/setup", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SETUP_TOKEN_REQUIRED" }),
    );
    expect(db.data.users.length).toBe(0);
  });

  it("refuses a wrong token", async () => {
    await getOrCreateSetupToken(); // establish the real token first
    const req = makeReq(
      {
        username: "op",
        password: "correct horse battery",
        setupToken: "definitely-not-it",
      },
      "10.0.0.2",
    );
    const res = createResponse();
    await runRoute("/setup", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(db.data.users.length).toBe(0);
  });

  it("accepts the correct token exactly once, and clearSetupToken() makes reuse fail on a second attempt", async () => {
    const token = await getOrCreateSetupToken();

    const firstReq = makeReq(
      { username: "opuser", password: "correct horse battery", setupToken: token },
      "10.0.0.3",
    );
    const firstRes = createResponse();
    await runRoute("/setup", "post", firstReq, firstRes);
    expect(firstRes.status).toHaveBeenCalledWith(201);
    expect(db.data.users.length).toBe(1);
    // The token itself is now cleared — reusing it is not what blocks the
    // second attempt below on its own, but it must not still validate.
    expect(settings.get("setupToken")).toBeNull();

    // Second attempt with the SAME (now-stale) token: needsSetup() is false
    // once a user exists, so /setup's own existing "already completed"
    // guard is what actually stops it — proving the gate doesn't get in
    // the way of that pre-existing behavior, and that a captured token
    // can't be replayed to create a second admin account.
    const secondReq = makeReq(
      { username: "second", password: "another password", setupToken: token },
      "10.0.0.3",
    );
    const secondRes = createResponse();
    await runRoute("/setup", "post", secondReq, secondRes);
    expect(secondRes.status).toHaveBeenCalledWith(400);
    expect(db.data.users.length).toBe(1);
  });
});

describe("authService.bootstrapAdminFromExternalIdentity() — the OIDC bootstrap door", () => {
  beforeEach(() => {
    settings.clear();
    db.data.users = [];
  });

  const identity = {
    issuer: "https://idp.example.com",
    subject: "sub-123",
    email: "op@example.com",
    username: "opidc",
  };

  it("refuses a missing setup token", async () => {
    await expect(
      authService.bootstrapAdminFromExternalIdentity({ ...identity }),
    ).rejects.toThrow(/setup token/i);
    expect(db.data.users.length).toBe(0);
  });

  it("refuses a wrong setup token", async () => {
    await getOrCreateSetupToken();
    await expect(
      authService.bootstrapAdminFromExternalIdentity({
        ...identity,
        setupToken: "wrong",
      }),
    ).rejects.toThrow(/setup token/i);
    expect(db.data.users.length).toBe(0);
  });

  it("accepts the correct token exactly once, and a second call (even with the same identity) fails once a user exists", async () => {
    const token = await getOrCreateSetupToken();

    const created = await authService.bootstrapAdminFromExternalIdentity({
      ...identity,
      setupToken: token,
    });
    expect(created.role).toBe("admin");
    expect(db.data.users.length).toBe(1);
    expect(settings.get("setupToken")).toBeNull();

    await expect(
      authService.bootstrapAdminFromExternalIdentity({
        ...identity,
        setupToken: token,
      }),
    ).rejects.toThrow(/Setup already completed/i);
    expect(db.data.users.length).toBe(1);
  });
});
