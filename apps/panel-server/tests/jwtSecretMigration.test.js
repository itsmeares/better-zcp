import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import jwt from "jsonwebtoken";

// Same in-memory db/settings stand-in as setupTokenGate.test.js, PLUS a real
// isolated temp dir for utils/paths.js — authService.init() now touches
// both db.json (via getSetting/setSetting) and a real jwt.secret file (via
// utils/jwtSecret.js), so both need to be test-owned rather than falling
// back to whatever paths.config.json happens to be live in the repo root
// right now (another agent's session, per the "already exists and is not
// ours" globalSetup message — must not touch that).
const settings = new Map();
const db = { data: { users: [] } };
// Seeded with a real directory immediately (not inside beforeEach): the
// static imports below run at module-load time, before any hook fires, and
// services/auth.js's import chain reaches utils/logger.js, which calls
// getDataPaths() and mkdirSync's logsDir right away. beforeEach still swaps
// this out per test for isolation between tests.
//
// initDir is kept as its OWN stable constant, separate from the mutable
// tmpDir below (ENOTEMPTY class, hunt-wave12, 2026-08-29/30): tmpDir gets
// reassigned to a fresh directory by every describe block's beforeEach, but
// logger.js's winston singleton resolved logsDir from THIS value, once, at
// the static import a few lines down -- it never re-reads getDataPaths()
// afterward. No hook in this file ever deletes initDir, which is exactly
// why it used to leak a real winston logger's files forever (measured on
// this machine: 669 such directories from this one file's prefix alone,
// every sampled one containing real combined.log/error.log). See the
// regression test at the bottom of this file.
const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtmigration-init-"));
let tmpDir = initDir;

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
}));

vi.mock("../utils/paths.js", () => ({
  // utils/logger.js also calls getDataPaths() at import time for logsDir —
  // needs a real, existing path or its own mkdirSync throws before any test
  // body runs.
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

// ENOTEMPTY class (hunt-wave12, 2026-08-29/30): services/auth.js imports
// utils/logger.js, so without this the real winston logger resolved its
// logsDir from initDir above (captured at the moment of the static import
// a few lines down) and wrote real log files into it for the lifetime of
// this file's test run -- confirmed: 669 leaked "-init-" directories from
// this exact file already on this machine before this fix, every sampled
// one holding real combined.log/error.log. Never the same directory any
// per-test afterEach deletes, so never an ENOTEMPTY risk the way
// modThumbnailResolution.test.js's race was (5d5a9088) -- but a real,
// separate, measured leak this mock closes. Matches the convention already
// established elsewhere in this suite (see e.g.
// linuxLaunchExtensionlessCustomCommand.test.js).
vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { default: authService } = await import("../services/auth.js");
const { getJwtSecretPath } = await import("../utils/jwtSecret.js");
const { default: authRouter } = await import("../routes/auth.js");

function createResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
    cookie: vi.fn(),
    clearCookie: vi.fn(),
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

describe("authService.init() — JWT secret migration out of db.json", () => {
  beforeEach(() => {
    settings.clear();
    db.data.users = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtmigration-"));
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_FILE;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fresh install: generates a key, no legacy value to clear from db.json", async () => {
    await authService.init();
    expect(authService.jwtSecret).toMatch(/^[0-9a-f]{128}$/);
    expect(settings.get("jwtSecret")).toBeUndefined();
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe(
      authService.jwtSecret,
    );
  });

  it("existing install: a legacy jwtSecret in db.json migrates verbatim and is cleared from db.json", async () => {
    settings.set("jwtSecret", "legacy-value-from-old-install");

    await authService.init();

    expect(authService.jwtSecret).toBe("legacy-value-from-old-install");
    expect(settings.get("jwtSecret")).toBeNull(); // cleared, not just left stale
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe(
      "legacy-value-from-old-install",
    );
  });

  it("a token signed before the upgrade still authenticates a real request after migration — zero forced logout", async () => {
    const legacySecret = "legacy-value-that-already-signed-a-real-session";
    settings.set("jwtSecret", legacySecret);
    const tokenIssuedBeforeUpgrade = jwt.sign(
      { userId: "u1", tokenGen: 0 },
      legacySecret,
    );
    db.data.users = [{ id: "u1", username: "admin", role: "admin", tokenGen: 0 }];

    await authService.init();

    const authenticated = await authService.authenticateAccessToken(
      tokenIssuedBeforeUpgrade,
    );
    expect(authenticated).not.toBeNull();
    expect(authenticated.username).toBe("admin");
  });

  it("JWT_SECRET env override wins even with a legacy db.json value present, and still clears the stale db.json copy", async () => {
    // 32+ chars -- long enough to clear MIN_JWT_SECRET_LENGTH (see
    // jwtSecret.test.js for the dedicated length-guard tests); this test is
    // about override precedence / regeneration refusal, not length.
    process.env.JWT_SECRET = "env-pinned-secret-that-is-at-least-32-chars";
    settings.set("jwtSecret", "legacy-value-now-unused");

    await authService.init();

    expect(authService.jwtSecret).toBe("env-pinned-secret-that-is-at-least-32-chars");
    expect(settings.get("jwtSecret")).toBeNull();
  });

  it("fails loud and does not start when jwt.secret exists but is unreadable — never silently regenerates", async () => {
    fs.mkdirSync(getJwtSecretPath()); // directory at the path -> unreadable as a file
    // bug hunt 2026-08-31-c (under-coverage sweep): the title's own third
    // clause -- "never silently regenerates" -- had no assertion; only the
    // rejection itself was checked. authService is a shared singleton
    // across every test in this file (module-scoped, not reset between
    // `it`s), so by the time this test runs jwtSecret/initialized already
    // hold a REAL value from an earlier test in this same describe block --
    // asserting they equal null/false here would be wrong (it would fail
    // on correct code, for the wrong reason: leftover state, not a
    // regression). The actual claim is that init()'s catch block leaves
    // them UNTOUCHED, so the correct check is relative: capture them
    // before the call, assert they're unchanged after.
    const before = {
      jwtSecret: authService.jwtSecret,
      initialized: authService.initialized,
    };

    await expect(authService.init()).rejects.toThrow(/could not be read/i);

    expect(authService.jwtSecret).toBe(before.jwtSecret);
    expect(authService.initialized).toBe(before.initialized);
  });
});

describe("authService.regenerateJwtSecret()", () => {
  beforeEach(async () => {
    settings.clear();
    db.data.users = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtregen-"));
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_FILE;
    await authService.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("changes the in-memory secret and invalidates a token signed before regeneration", async () => {
    const oldSecret = authService.jwtSecret;
    const oldToken = jwt.sign({ userId: "u1", tokenGen: 0 }, oldSecret);
    db.data.users = [{ id: "u1", username: "admin", role: "admin", tokenGen: 0 }];

    await authService.regenerateJwtSecret();

    expect(authService.jwtSecret).not.toBe(oldSecret);
    const authenticated = await authService.authenticateAccessToken(oldToken);
    expect(authenticated).toBeNull();
  });

  it("refuses when a JWT_SECRET environment override is active, with an actionable message", async () => {
    // 32+ chars -- long enough to clear MIN_JWT_SECRET_LENGTH (see
    // jwtSecret.test.js for the dedicated length-guard tests); this test is
    // about override precedence / regeneration refusal, not length.
    process.env.JWT_SECRET = "env-pinned-secret-that-is-at-least-32-chars";
    await expect(authService.regenerateJwtSecret()).rejects.toThrow(
      /environment variable/i,
    );
  });
});

describe("POST /api/auth/regenerate-jwt-secret — admin-only route gate", () => {
  beforeEach(async () => {
    settings.clear();
    db.data.users = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtregen-route-"));
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_FILE;
    await authService.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses a technician", async () => {
    const req = { user: { role: "technician" } };
    const res = createResponse();
    await runRoute("/regenerate-jwt-secret", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("refuses a moderator", async () => {
    const req = { user: { role: "moderator" } };
    const res = createResponse();
    await runRoute("/regenerate-jwt-secret", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("admits an admin, invalidates the caller's own refresh cookie, and reports success", async () => {
    const oldSecret = authService.jwtSecret;
    const req = { user: { role: "admin", username: "boss" }, headers: {} };
    const res = createResponse();

    await runRoute("/regenerate-jwt-secret", "post", req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.clearCookie).toHaveBeenCalledWith(
      "refreshToken",
      expect.any(Object),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(authService.jwtSecret).not.toBe(oldSecret);
  });
});

// ENOTEMPTY class regression (hunt-wave12, 2026-08-29/30): placed last so
// every test above (which collectively exercise real authService/RCON
// activity that would otherwise produce real log lines) has already run.
// Before the logger.js mock above, this failed -- initDir genuinely
// contained combined.log/error.log, measured directly on this machine.
// After it, nothing ever writes into initDir at all, so this stays green
// rather than decorative.
describe("ENOTEMPTY class regression: the module-load-time seed directory never receives real logger writes", () => {
  it("initDir (captured at the static import above, never deleted by any hook) contains no *.log files", () => {
    expect(
      fs.readdirSync(initDir).filter((f) => f.endsWith(".log")),
    ).toEqual([]);
  });
});
