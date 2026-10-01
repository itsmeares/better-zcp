import { setPanelRuntime, setServerRuntime } from "../utils/panelRuntime.ts";
import { requireServerId } from "../utils/serverScope.ts";
import { scopedTests } from "./helpers/serverScope.ts";
import { createServer } from "../database/init.ts";
const it = scopedTests(async () => (await createServer({ serverName: "test" })).id);
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";

const { default: debugRouter } = await import("../routes/debug.ts");
const gameIntegration = {
  getStatus: () => ({
    configured: false,
    isRunning: false,
    modConnected: false,
    path: null,
    modStatus: null,
  }),
};

let originalFetch;
beforeEach(() => {
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
  setPanelRuntime({});
  setServerRuntime(requireServerId(), { gameIntegration });
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
  return body.checks?.find((check) => check.id === id);
}

describe("GET /debug/worldmap provider diagnostics", () => {
  it("reports provider outages as warnings and keeps the direct tile delivery DTO", async () => {
    const response = await runRoute("/worldmap", "get", adminReq());

    expect(response.getStatusCode()).toBe(200);
    expect(findCheck(response.getBody(), "worldmap.tiles.provider")).toMatchObject({
      status: "warn",
      label: "PZMap metadata provider unavailable",
    });
    expect(response.getBody()).toMatchObject({
      available: false,
      provider: { origin: "https://pzmap.org", status: "error" },
      tiles: {
        origin: "https://tiles.pzmap.org",
        mode: "direct",
        referrerPolicy: "no-referrer",
      },
    });
    expect(response.getBody()).not.toHaveProperty("tileSources");
    expect(response.getBody()).not.toHaveProperty("proxy");
  });
});
