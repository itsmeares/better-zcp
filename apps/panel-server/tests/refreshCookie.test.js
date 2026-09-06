import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRefreshCookieOptions } = await import(
  "../utils/refreshCookie.js"
);

function makeReq({ secure = false, forwardedProto = null } = {}) {
  return {
    secure,
    headers: forwardedProto ? { "x-forwarded-proto": forwardedProto } : {},
  };
}

describe("getRefreshCookieOptions — the one definition routes/auth.js and routes/oidc.js both import", () => {
  const originalHttps = process.env.HTTPS;
  const originalForceHsts = process.env.FORCE_HSTS;

  beforeEach(() => {
    delete process.env.HTTPS;
    delete process.env.FORCE_HSTS;
  });

  afterEach(() => {
    if (originalHttps === undefined) delete process.env.HTTPS;
    else process.env.HTTPS = originalHttps;
    if (originalForceHsts === undefined) delete process.env.FORCE_HSTS;
    else process.env.FORCE_HSTS = originalForceHsts;
  });

  it("returns the fixed security-relevant fields regardless of request", () => {
    const opts = getRefreshCookieOptions(makeReq());
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("strict");
    expect(opts.path).toBe("/api/auth");
  });

  it("includes maxAge by default (the SET-cookie case)", () => {
    const opts = getRefreshCookieOptions(makeReq());
    expect(opts.maxAge).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("omits maxAge when includeMaxAge=false (the CLEAR-cookie case)", () => {
    const opts = getRefreshCookieOptions(makeReq(), false);
    expect(opts).not.toHaveProperty("maxAge");
  });

  it("secure is false for a plain HTTP request with no override", () => {
    const opts = getRefreshCookieOptions(makeReq({ secure: false }));
    expect(opts.secure).toBe(false);
  });

  it("secure is true when the request itself is secure", () => {
    const opts = getRefreshCookieOptions(makeReq({ secure: true }));
    expect(opts.secure).toBe(true);
  });

  it("secure is true behind a reverse proxy via x-forwarded-proto", () => {
    const opts = getRefreshCookieOptions(
      makeReq({ secure: false, forwardedProto: "https" }),
    );
    expect(opts.secure).toBe(true);
  });

  // forceSecureCookies is computed once at module scope (matches the
  // original behavior this was extracted from verbatim — real deployments
  // set HTTPS/FORCE_HSTS before the process starts). Mutating process.env
  // after the top-level import above has no effect, so these two need a
  // genuinely fresh module load to observe.
  it("HTTPS=true forces secure even for a request that looks insecure — the mixed LAN+remote deployment case", async () => {
    process.env.HTTPS = "true";
    vi.resetModules();
    const { getRefreshCookieOptions: freshGetOptions } = await import(
      "../utils/refreshCookie.js"
    );
    const opts = freshGetOptions(makeReq({ secure: false }));
    expect(opts.secure).toBe(true);
  });

  it("FORCE_HSTS=true also forces secure", async () => {
    process.env.FORCE_HSTS = "true";
    vi.resetModules();
    const { getRefreshCookieOptions: freshGetOptions } = await import(
      "../utils/refreshCookie.js"
    );
    const opts = freshGetOptions(makeReq({ secure: false }));
    expect(opts.secure).toBe(true);
  });
});
