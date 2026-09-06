import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// Coverage for worldmap.tiles.buildDetect's two getB42ResolutionStatus()
// source states (conv-mapbuild). A third 'client' state -- the operator's
// browser resolving the build the panel host couldn't -- was proposed,
// built, and then cancelled within the same task: pzmap.org sends no CORS
// headers on one host, and the CORS-open host challenged every browser
// tested with an inconsistent bot-detection response. It could not be
// demonstrated to work, so it does not exist here, not even as a dormant
// branch or a "not currently produced" comment -- an unreachable branch
// is dead code, and a note describing it as merely dormant is exactly the
// kind of thing that goes stale and misleads the next reader.

vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName: mockGetRoleByName };
});

const getB42ResolutionStatus = vi.fn();
const getB42Dir = vi.fn();
const getB42TopFormat = vi.fn();
vi.mock("../routes/mapProxy.js", async () => {
  const actual = await vi.importActual("../routes/mapProxy.js");
  return { ...actual, getB42ResolutionStatus, getB42Dir, getB42TopFormat };
});

const { default: debugRouter } = await import("../routes/debug.js");

// The /worldmap handler calls getB42Dir()/getB42TopFormat() for real
// (unrelated to the buildDetect check these tests target) and then probes
// three tile URLs with a real fetch(), each under its own 5s timeout.
// Jim's curl-based discovery in mapProxy.js is correct but genuinely slower
// than the old fetch-based version, and under a full 132-file suite run
// (shared CPU/network with everything else) that pushed this test right up
// against vitest's own per-test timeout -- flaky under load, reliably green
// in isolation. Stubbing all three removes every source of live network
// wall-clock time from a test that only asserts on the buildDetect check
// entry, not on b42Dir/b42TopFormat/the tile probes themselves.
let originalFetch;
beforeEach(() => {
  getB42Dir.mockResolvedValue("42.20.0");
  getB42TopFormat.mockResolvedValue("jpg");
  originalFetch = global.fetch;
  global.fetch = vi.fn(async () => {
    throw new Error("network disabled for this test");
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getLayer(routePath, method) {
  return debugRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(routePath, method, req) {
  const res = createResponse();
  const layer = getLayer(routePath, method);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function adminReq(overrides = {}) {
  return {
    user: { role: "admin" },
    params: {},
    query: {},
    body: {},
    app: { get: () => undefined },
    ...overrides,
  };
}

function findCheck(body, id) {
  return body.checks?.find((c) => c.id === id);
}

describe("GET /debug/worldmap: worldmap.tiles.buildDetect reports both getB42ResolutionStatus() sources distinctly", () => {
  it("source: 'dynamic' -> status ok, with a hint that this depends on an upstream heuristic and isn't permanent", async () => {
    getB42ResolutionStatus.mockReturnValue({
      source: "dynamic",
      directory: "42.20.0",
      reason: null,
    });

    const res = await runRoute("/worldmap", "get", adminReq());

    expect(res.getStatusCode()).toBe(200);
    const check = findCheck(res.getBody(), "worldmap.tiles.buildDetect");
    expect(check).toBeTruthy();
    expect(check.status).toBe("ok");
    expect(check.message).toContain("42.20.0");
    expect(check.params).toEqual({ build: "42.20.0" });
    // A cancelled third tier ('client', the browser resolving what the
    // panel couldn't) was investigated and killed -- upstream sends no CORS
    // headers on one host and an inconsistent bot-challenge on the other.
    // Resolution now goes through curl and only works with a realistic
    // browser user-agent, an upstream heuristic outside the panel's
    // control. The hint says so plainly rather than reading as solved.
    expect(check.hint).toBeTruthy();
    expect(check.hint.toLowerCase()).toContain("heuristic");
    expect(check.hint.toLowerCase()).toContain("not permanently solved");
  });

  it("source: 'fallback' -> status warn", async () => {
    getB42ResolutionStatus.mockReturnValue({
      source: "fallback",
      directory: "42.19.0",
      reason: "build_list.json listed no B42+ candidates",
    });

    const res = await runRoute("/worldmap", "get", adminReq());

    expect(res.getStatusCode()).toBe(200);
    const check = findCheck(res.getBody(), "worldmap.tiles.buildDetect");
    expect(check).toBeTruthy();
    expect(check.status).toBe("warn");
    expect(check.message).toContain("42.19.0");
    expect(check.message).toContain("build_list.json listed no B42+ candidates");
    expect(check.params).toEqual({
      build: "42.19.0",
      reason: "build_list.json listed no B42+ candidates",
    });
  });

  it("an unrecognized source value fails closed to the warn branch, not the ok branch", async () => {
    // Defensive: any source value other than the exact string "dynamic"
    // must not be silently treated as healthy.
    getB42ResolutionStatus.mockReturnValue({
      source: "something-not-in-the-contract",
      directory: "42.19.0",
      reason: null,
    });

    const res = await runRoute("/worldmap", "get", adminReq());

    const check = findCheck(res.getBody(), "worldmap.tiles.buildDetect");
    expect(check.status).toBe("warn");
  });
});
