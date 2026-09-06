import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";


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
